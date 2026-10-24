//! Teams DAGpipe runner.
//!
//! One project-owned, per-execution process. It parses one of the project graph
//! files, registers the fixed Teams Operators, compiles the graph with the
//! granted effect capabilities, and hands the immutable `CompiledGraph` to the
//! SDK `Runtime`. Node scheduling stays inside the SDK.
//!
//! Host interactions are typed JSON lines: the runner emits `host.call` on
//! stdout and the Node host answers `host.result`/`host.error` on stdin. Control
//! correlation and business payloads are physically separate fields.

use pipeline_runtime::{
    compile, parse_graph_json, Cancellation, EffectReplay, Identity, Operator, OperatorContext,
    Registry, Runtime, ValueType,
};
use serde_json::{json, Map, Value};
use std::collections::{BTreeSet, HashMap};
use std::io::{BufRead, Write};

const OPERATOR_VERSION: &str = "1";

const CAP_DIRECTORY_READ: &str = "directory.read";
const CAP_NETWORK_CONNECT: &str = "network.connect";
const CAP_WORK_PROPOSE: &str = "agent.work.propose";
const CAP_WORK_REQUEST: &str = "agent.work.request";
const CAP_WORK_CLOSE: &str = "agent.work.close";
const CAP_NETWORK_CLOSE: &str = "network.close";
const CAP_WORK_GET: &str = "agent.work.get";

/// Fixed effect grant for the Teams Work graphs. The Node host must actually
/// hold every one of these capabilities; compile rejects a graph that needs a
/// capability absent from the grant before any host call is made.
const DEFAULT_CAPABILITIES: &[&str] = &[
    CAP_DIRECTORY_READ,
    CAP_NETWORK_CONNECT,
    CAP_WORK_PROPOSE,
    CAP_WORK_REQUEST,
    CAP_WORK_CLOSE,
    CAP_NETWORK_CLOSE,
    CAP_WORK_GET,
];

/// One typed ARC value: control facts and the untouched business payload.
struct ArcInput {
    control: Map<String, Value>,
    business: Option<Value>,
}

impl ArcInput {
    fn decode(input: &Value) -> Result<Self, String> {
        let object = input
            .as_object()
            .ok_or_else(|| "operator input ARC must be an object".to_owned())?;
        let control = object
            .get("control")
            .and_then(Value::as_object)
            .cloned()
            .ok_or_else(|| "operator input ARC control must be an object".to_owned())?;
        Ok(Self {
            control,
            business: object.get("business").cloned(),
        })
    }

    fn string(&self, key: &str) -> Result<String, String> {
        self.control
            .get(key)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .ok_or_else(|| format!("control.{key} must be a non-empty string"))
    }

    fn integer(&self, key: &str) -> Result<i64, String> {
        self.control
            .get(key)
            .and_then(Value::as_i64)
            .ok_or_else(|| format!("control.{key} must be an integer"))
    }

    fn optional_integer(&self, key: &str) -> Result<Option<i64>, String> {
        match self.control.get(key) {
            None => Ok(None),
            Some(value) => value.as_i64().map(Some).ok_or_else(|| format!("control.{key} must be an integer when present")),
        }
    }

    fn service_selection(&self) -> Result<String, String> {
        Ok(self
            .control
            .get("serviceSelection")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .unwrap_or("endpoint")
            .to_owned())
    }

    fn demands(&self) -> Result<Value, String> {
        let demands = self
            .control
            .get("demands")
            .cloned()
            .ok_or_else(|| "control.demands is required".to_owned())?;
        let items = demands
            .as_array()
            .ok_or_else(|| "control.demands must be an array".to_owned())?;
        for item in items {
            let object = item
                .as_object()
                .ok_or_else(|| "control.demands entries must be objects".to_owned())?;
            if object
                .get("resourceId")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .is_none()
            {
                return Err("control.demands[].resourceId must be a non-empty string".to_owned());
            }
            let amount = object
                .get("amount")
                .and_then(Value::as_i64)
                .ok_or_else(|| "control.demands[].amount must be an integer".to_owned())?;
            if amount < 1 {
                return Err("control.demands[].amount must be positive".to_owned());
            }
        }
        Ok(demands)
    }

    fn business_required(&self) -> Result<Value, String> {
        self.business
            .clone()
            .ok_or_else(|| "operator input ARC business payload is required".to_owned())
    }

    fn encode(self) -> Value {
        let mut object = Map::new();
        object.insert("control".to_owned(), Value::Object(self.control));
        if let Some(business) = self.business {
            object.insert("business".to_owned(), business);
        }
        Value::Object(object)
    }
}

struct HostError {
    code: String,
    message: String,
    delivery_state: Option<String>,
}

struct HostCallResult {
    result: Value,
    business: Option<Value>,
}

impl HostError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_owned(),
            message: message.into(),
            delivery_state: None,
        }
    }


    fn into_message(self) -> String {
        let delivery = match self.delivery_state.as_deref() {
            Some("unconfirmed") => " (deliveryState=unconfirmed)",
            Some(other) => {
                return format!("{}: {} (deliveryState={other})", self.code, self.message);
            }
            None => "",
        };
        if self.code.is_empty() {
            format!("{}{delivery}", self.message)
        } else {
            format!("{}: {}{delivery}", self.code, self.message)
        }
    }
}

enum ReadError {
    Eof,
    Io(String),
}

fn write_stdout_line(line: &str) -> Result<(), String> {
    let stdout = std::io::stdout();
    let mut output = stdout.lock();
    writeln!(output, "{line}").map_err(|error| format!("stdout write failed: {error}"))?;
    output
        .flush()
        .map_err(|error| format!("stdout flush failed: {error}"))
}

fn read_stdin_line() -> Result<String, ReadError> {
    let stdin = std::io::stdin();
    let mut input = stdin.lock();
    let mut line = String::new();
    let read = input
        .read_line(&mut line)
        .map_err(|error| ReadError::Io(format!("host response read failed: {error}")))?;
    if read == 0 {
        return Err(ReadError::Eof);
    }
    Ok(line.trim_end().to_owned())
}

/// One typed host call: emit `host.call`, then consume the correlated reply.
fn host_call(
    operator: &str,
    context: &OperatorContext,
    operation: &str,
    args: Value,
    business: Option<Value>,
) -> Result<HostCallResult, HostError> {
    let request_id = format!(
        "{}/{}/{}",
        context.identity.execution_id, context.node_id, context.identity.attempt_id
    );
    let mut frame = Map::new();
    frame.insert("type".to_owned(), Value::String("host.call".to_owned()));
    frame.insert(
        "control".to_owned(),
        json!({
            "request_id": &request_id,
            "operation": operation,
            "operator": operator,
            "node_id": &context.node_id,
            "identity": &context.identity,
            "args": args,
        }),
    );
    if let Some(business) = business {
        frame.insert("business".to_owned(), business);
    }
    let encoded = serde_json::to_string(&Value::Object(frame))
        .map_err(|error| HostError::new("HOST_ENCODE", error.to_string()))?;
    write_stdout_line(&encoded).map_err(|message| HostError::new("HOST_WRITE", message))?;

    let line = match read_stdin_line() {
        Ok(line) => line,
        Err(ReadError::Eof) => {
            return Err(HostError::new(
                "HOST_EOF",
                "host EOF before host.result/host.error",
            ))
        }
        Err(ReadError::Io(message)) => return Err(HostError::new("HOST_READ", message)),
    };
    let response: Value = serde_json::from_str(&line)
        .map_err(|error| HostError::new("HOST_PROTOCOL", format!("host response is not JSON: {error}")))?;
    let control = response
        .get("control")
        .and_then(Value::as_object)
        .ok_or_else(|| HostError::new("HOST_PROTOCOL", "host response lacks control object"))?;
    let response_request_id = control
        .get("request_id")
        .and_then(Value::as_str)
        .ok_or_else(|| HostError::new("HOST_PROTOCOL", "host response lacks control.request_id"))?;
    if response_request_id != request_id.as_str() {
        return Err(HostError::new(
            "HOST_PROTOCOL",
            format!(
                "host response correlation mismatch: expected `{request_id}`, got `{response_request_id}`"
            ),
        ));
    }
    let response_operation = control
        .get("operation")
        .and_then(Value::as_str)
        .ok_or_else(|| HostError::new("HOST_PROTOCOL", "host response lacks control.operation"))?;
    if response_operation != operation {
        return Err(HostError::new(
            "HOST_PROTOCOL",
            format!(
                "host response operation mismatch: expected `{operation}`, got `{response_operation}`"
            ),
        ));
    }
    match response.get("type").and_then(Value::as_str) {
        Some("host.result") => {
            if control.get("status").and_then(Value::as_str) != Some("ok") {
                return Err(HostError::new(
                    "HOST_PROTOCOL",
                    "host.result control.status is not `ok`",
                ));
            }
            let result = control
                .get("result")
                .cloned()
                .ok_or_else(|| HostError::new("HOST_PROTOCOL", "host.result lacks control.result"))?;
            Ok(HostCallResult {
                result,
                business: response.get("business").cloned(),
            })
        }
        Some("host.error") => {
            if control.get("status").and_then(Value::as_str) != Some("error") {
                return Err(HostError::new(
                    "HOST_PROTOCOL",
                    "host.error control.status is not `error`",
                ));
            }
            let error = control
                .get("error")
                .and_then(Value::as_object)
                .ok_or_else(|| HostError::new("HOST_PROTOCOL", "host.error lacks control.error object"))?;
            let code = error
                .get("code")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| HostError::new("HOST_PROTOCOL", "host.error control.error.code is missing"))?
                .to_owned();
            let message = error
                .get("message")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .unwrap_or("host reported an error")
                .to_owned();
            let delivery_state = error
                .get("deliveryState")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_owned);
            Err(HostError {
                code,
                message,
                delivery_state,
            })
        }
        Some(other) => Err(HostError::new(
            "HOST_PROTOCOL",
            format!("unsupported host response type `{other}`"),
        )),
        None => Err(HostError::new("HOST_PROTOCOL", "host response lacks type")),
    }
}

fn is_terminal_request_state(state: &str) -> bool {
    matches!(state, "succeeded" | "failed" | "cancelled")
}

struct ResolvePeerService;

impl Operator for ResolvePeerService {
    fn name(&self) -> &'static str {
        "teams.resolve-peer-service"
    }
    fn version(&self) -> &'static str {
        OPERATOR_VERSION
    }
    fn input_type(&self) -> ValueType {
        ValueType::Object
    }
    fn output_type(&self) -> ValueType {
        ValueType::Object
    }
    fn effects(&self) -> &'static [&'static str] {
        &[CAP_DIRECTORY_READ]
    }
    fn replay(&self) -> EffectReplay {
        EffectReplay::Replayable
    }
    fn execute(&self, input: Value, context: &OperatorContext) -> Result<Value, String> {
        let arc = ArcInput::decode(&input)?;
        let selection = arc.service_selection()?;
        let persistent = matches!(
            context.identity.graph_id.as_str(),
            "agentteams.work-open" | "agentteams.work-request" | "agentteams.work-close"
        );
        if persistent && selection != "capability" {
            return Err(format!(
                "{} requires serviceSelection=capability",
                context.identity.graph_id
            ));
        }
        let args = if selection == "capability" {
            let target_generation = arc
                .optional_integer("targetGeneration")?
                .ok_or_else(|| "control.targetGeneration is required for capability selection".to_owned())?;
            let link_generation = arc.optional_integer("linkGeneration")?;
            let query = context.identity.graph_id == "agentteams.work-query";
            if !query && link_generation.is_some() {
                return Err("control.linkGeneration is only valid for capability query".to_owned());
            }
            let mut selection = json!({
                "mode": "capability",
                "providerAgentId": arc.string("targetAgentId")?,
                "targetGeneration": target_generation,
                "generationPolicy": if query { "current" } else { "exact" },
            });
            if let Some(link_generation) = link_generation {
                selection["linkGeneration"] = Value::from(link_generation);
            }
            json!({
                "capabilityId": arc.string("capabilityId")?,
                "capabilityVersion": arc.string("capabilityVersion")?,
                "operation": arc.string("operation")?,
                "serviceSelection": selection,
            })
        } else {
            json!({
                "capabilityId": arc.string("capabilityId")?,
                "capabilityVersion": arc.string("capabilityVersion")?,
                "operation": arc.string("operation")?,
                "providerAgentId": arc.string("targetAgentId")?,
            })
        };
        let response =
            host_call(self.name(), context, "agentWork.findProvider", args, None).map_err(HostError::into_message)?;
        let target = response.result
            .get("target")
            .cloned()
            .ok_or_else(|| "host result lacks target".to_owned())?;
        let object = target
            .as_object()
            .ok_or_else(|| "host target must be an object".to_owned())?;
        for key in ["providerAgentId", "capabilityId", "capabilityVersion", "operation", "serviceSelection"] {
            if object
                .get(key)
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .is_none()
            {
                return Err(format!("host target.{key} must be a non-empty string"));
            }
        }
        if object.get("generation").and_then(Value::as_i64).is_none() {
            return Err("host target.generation must be an integer".to_owned());
        }
        let mut control = arc.control.clone();
        control.insert("target".to_owned(), target);
        Ok(ArcInput {
            control,
            business: arc.business,
        }
        .encode())
    }
}

struct OpenWorkLink;

impl Operator for OpenWorkLink {
    fn name(&self) -> &'static str {
        "teams.open-work-link"
    }
    fn version(&self) -> &'static str {
        OPERATOR_VERSION
    }
    fn input_type(&self) -> ValueType {
        ValueType::Object
    }
    fn output_type(&self) -> ValueType {
        ValueType::Object
    }
    fn effects(&self) -> &'static [&'static str] {
        &[CAP_NETWORK_CONNECT]
    }
    fn replay(&self) -> EffectReplay {
        EffectReplay::RequiresConfirmation
    }
    fn execute(&self, input: Value, context: &OperatorContext) -> Result<Value, String> {
        let arc = ArcInput::decode(&input)?;
        let target = arc
            .control
            .get("target")
            .cloned()
            .ok_or_else(|| "control.target is required".to_owned())?;
        let response = host_call(
            self.name(),
            context,
            "agentWork.open",
            json!({ "target": target }),
            None,
        )
        .map_err(HostError::into_message)?;
        let channel_ref = response.result
            .get("channelRef")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "host result lacks channelRef".to_owned())?
            .to_owned();
        let mut control = arc.control.clone();
        control.insert("channelRef".to_owned(), Value::String(channel_ref));
        Ok(ArcInput {
            control,
            business: arc.business,
        }
        .encode())
    }
}

struct AdmitProviderWork;

impl Operator for AdmitProviderWork {
    fn name(&self) -> &'static str {
        "teams.admit-provider-work"
    }
    fn version(&self) -> &'static str {
        OPERATOR_VERSION
    }
    fn input_type(&self) -> ValueType {
        ValueType::Object
    }
    fn output_type(&self) -> ValueType {
        ValueType::Object
    }
    fn effects(&self) -> &'static [&'static str] {
        &[CAP_WORK_PROPOSE]
    }
    fn replay(&self) -> EffectReplay {
        EffectReplay::RequiresConfirmation
    }
    fn execute(&self, input: Value, context: &OperatorContext) -> Result<Value, String> {
        let arc = ArcInput::decode(&input)?;
        let args = json!({
            "channelRef": arc.string("channelRef")?,
            "workId": arc.string("workId")?,
            "capabilityId": arc.string("capabilityId")?,
            "capabilityVersion": arc.string("capabilityVersion")?,
            "policyRevision": arc.integer("policyRevision")?,
        });
        let response = host_call(self.name(), context, "agentWork.propose", args, None)
            .map_err(HostError::into_message)?;
        let accepted = response.result
            .get("accepted")
            .cloned()
            .ok_or_else(|| "host result lacks accepted Work".to_owned())?;
        let mut control = arc.control.clone();
        control.insert("accepted".to_owned(), accepted);
        Ok(ArcInput {
            control,
            business: arc.business,
        }
        .encode())
    }
}

struct RequestProviderWork;

impl Operator for RequestProviderWork {
    fn name(&self) -> &'static str {
        "teams.request-provider-work"
    }
    fn version(&self) -> &'static str {
        OPERATOR_VERSION
    }
    fn input_type(&self) -> ValueType {
        ValueType::Object
    }
    fn output_type(&self) -> ValueType {
        ValueType::Object
    }
    fn effects(&self) -> &'static [&'static str] {
        &[CAP_WORK_REQUEST]
    }
    fn replay(&self) -> EffectReplay {
        EffectReplay::RequiresConfirmation
    }
    fn execute(&self, input: Value, context: &OperatorContext) -> Result<Value, String> {
        let arc = ArcInput::decode(&input)?;
        let args = json!({
            "channelRef": arc.string("channelRef")?,
            "workId": arc.string("workId")?,
            "requestId": arc.string("requestId")?,
            "operation": arc.string("operation")?,
            "demands": arc.demands()?,
        });
        let response = host_call(
            self.name(),
            context,
            "agentWork.request",
            args,
            Some(arc.business_required()?),
        )
            .map_err(HostError::into_message)?;
        let reply_control = response.result
            .get("replyControl")
            .cloned()
            .ok_or_else(|| "host result lacks Work reply control".to_owned())?;
        let state = reply_control
            .get("state")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "host Work reply control.state is missing".to_owned())?
            .to_owned();
        let mut control = arc.control.clone();
        control.insert("reply".to_owned(), reply_control);
        control.insert("requestState".to_owned(), Value::String(state));
        Ok(ArcInput {
            control,
            business: response.business,
        }
        .encode())
    }
}

struct SettleProviderWork;

impl Operator for SettleProviderWork {
    fn name(&self) -> &'static str {
        "teams.settle-provider-work"
    }
    fn version(&self) -> &'static str {
        OPERATOR_VERSION
    }
    fn input_type(&self) -> ValueType {
        ValueType::Object
    }
    fn output_type(&self) -> ValueType {
        ValueType::Object
    }
    fn effects(&self) -> &'static [&'static str] {
        &[CAP_WORK_CLOSE, CAP_NETWORK_CLOSE]
    }
    fn replay(&self) -> EffectReplay {
        EffectReplay::RequiresConfirmation
    }
    fn execute(&self, input: Value, context: &OperatorContext) -> Result<Value, String> {
        let arc = ArcInput::decode(&input)?;
        let channel_ref = arc.string("channelRef")?;
        let work_id = arc.string("workId")?;
        let request_state = arc.string("requestState")?;
        let mut control = arc.control.clone();
        if is_terminal_request_state(&request_state) {
            let close = host_call(
                self.name(),
                context,
                "agentWork.close",
                json!({ "channelRef": &channel_ref, "workId": &work_id }),
                None,
            );
            match close {
                Ok(response) => {
                    control.insert("workClosure".to_owned(), Value::String("closed".to_owned()));
                    if let Some(work) = response.result.get("work") {
                        control.insert("closedWork".to_owned(), work.clone());
                    }
                }
                Err(error) => {
                    control.insert(
                        "workClosure".to_owned(),
                        Value::String("close-failed".to_owned()),
                    );
                    control.insert(
                        "closeError".to_owned(),
                        json!({ "code": error.code, "message": error.message }),
                    );
                    if let Some(delivery_state) = error.delivery_state {
                        control.insert("deliveryState".to_owned(), Value::String(delivery_state));
                    }
                }
            }
        } else {
            control.insert("workClosure".to_owned(), Value::String("retained".to_owned()));
        }
        // Connection disposal is an independent closeout; a failure here fails
        // the execution instead of pretending the receipt is complete.
        host_call(
            self.name(),
            context,
            "agentWork.dispose",
            json!({ "channelRef": channel_ref }),
            None,
        )
        .map_err(HostError::into_message)?;
        Ok(ArcInput {
            control,
            business: arc.business,
        }
        .encode())
    }
}

struct ReturnHeldWork;

impl Operator for ReturnHeldWork {
    fn name(&self) -> &'static str {
        "teams.return-held-work"
    }
    fn version(&self) -> &'static str {
        OPERATOR_VERSION
    }
    fn input_type(&self) -> ValueType {
        ValueType::Object
    }
    fn output_type(&self) -> ValueType {
        ValueType::Object
    }
    fn effects(&self) -> &'static [&'static str] {
        &[CAP_NETWORK_CLOSE]
    }
    fn replay(&self) -> EffectReplay {
        EffectReplay::RequiresConfirmation
    }
    fn execute(&self, input: Value, context: &OperatorContext) -> Result<Value, String> {
        let arc = ArcInput::decode(&input)?;
        let channel_ref = arc.string("channelRef")?;
        host_call(
            self.name(),
            context,
            "agentWork.dispose",
            json!({ "channelRef": channel_ref }),
            None,
        )
        .map_err(HostError::into_message)?;
        let mut control = arc.control.clone();
        control.insert("workClosure".to_owned(), Value::String("retained".to_owned()));
        Ok(ArcInput {
            control,
            business: arc.business,
        }
        .encode())
    }
}

struct ContinueProviderWork;

impl Operator for ContinueProviderWork {
    fn name(&self) -> &'static str {
        "teams.continue-provider-work"
    }
    fn version(&self) -> &'static str {
        OPERATOR_VERSION
    }
    fn input_type(&self) -> ValueType {
        ValueType::Object
    }
    fn output_type(&self) -> ValueType {
        ValueType::Object
    }
    fn effects(&self) -> &'static [&'static str] {
        &[CAP_WORK_REQUEST]
    }
    fn replay(&self) -> EffectReplay {
        EffectReplay::RequiresConfirmation
    }
    fn execute(&self, input: Value, context: &OperatorContext) -> Result<Value, String> {
        let arc = ArcInput::decode(&input)?;
        let args = json!({
            "channelRef": arc.string("channelRef")?,
            "workId": arc.string("workId")?,
            "requestId": arc.string("requestId")?,
            "operation": arc.string("operation")?,
            "demands": arc.demands()?,
        });
        let response = host_call(
            self.name(),
            context,
            "agentWork.request",
            args,
            Some(arc.business_required()?),
        )
        .map_err(HostError::into_message)?;
        let reply_control = response.result
            .get("replyControl")
            .cloned()
            .ok_or_else(|| "host result lacks Work reply control".to_owned())?;
        let state = reply_control
            .get("state")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "host Work reply control.state is missing".to_owned())?
            .to_owned();
        let mut control = arc.control.clone();
        control.insert("reply".to_owned(), reply_control);
        control.insert("requestState".to_owned(), Value::String(state));
        Ok(ArcInput {
            control,
            business: response.business,
        }
        .encode())
    }
}

struct CloseProviderWork;

impl Operator for CloseProviderWork {
    fn name(&self) -> &'static str {
        "teams.close-provider-work"
    }
    fn version(&self) -> &'static str {
        OPERATOR_VERSION
    }
    fn input_type(&self) -> ValueType {
        ValueType::Object
    }
    fn output_type(&self) -> ValueType {
        ValueType::Object
    }
    fn effects(&self) -> &'static [&'static str] {
        &[CAP_WORK_CLOSE, CAP_NETWORK_CLOSE]
    }
    fn replay(&self) -> EffectReplay {
        EffectReplay::RequiresConfirmation
    }
    fn execute(&self, input: Value, context: &OperatorContext) -> Result<Value, String> {
        let arc = ArcInput::decode(&input)?;
        let channel_ref = arc.string("channelRef")?;
        let work_id = arc.string("workId")?;
        let close = host_call(
            self.name(),
            context,
            "agentWork.close",
            json!({ "channelRef": &channel_ref, "workId": &work_id }),
            None,
        );
        let mut control = arc.control.clone();
        match close {
            Ok(response) => {
                let work = response.result
                    .get("work")
                    .cloned()
                    .ok_or_else(|| "host result lacks closed Work".to_owned())?;
                if work.get("state").and_then(Value::as_str) != Some("closed") {
                    return Err("provider did not confirm Work destruction".to_owned());
                }
                control.insert("workClosure".to_owned(), Value::String("closed".to_owned()));
                control.insert("closedWork".to_owned(), work);
            }
            Err(error) => {
                control.insert(
                    "workClosure".to_owned(),
                    Value::String("close-failed".to_owned()),
                );
                let mut close_error = Map::new();
                close_error.insert("code".to_owned(), Value::String(error.code));
                close_error.insert("message".to_owned(), Value::String(error.message));
                if let Some(delivery_state) = error.delivery_state {
                    control.insert("deliveryState".to_owned(), Value::String(delivery_state.clone()));
                    close_error.insert("deliveryState".to_owned(), Value::String(delivery_state));
                }
                control.insert("closeError".to_owned(), Value::Object(close_error));
            }
        }
        host_call(
            self.name(),
            context,
            "agentWork.dispose",
            json!({ "channelRef": channel_ref }),
            None,
        )
        .map_err(HostError::into_message)?;
        Ok(ArcInput {
            control,
            business: arc.business,
        }
        .encode())
    }
}

struct QueryProviderRequest;

impl Operator for QueryProviderRequest {
    fn name(&self) -> &'static str {
        "teams.query-provider-request"
    }
    fn version(&self) -> &'static str {
        OPERATOR_VERSION
    }
    fn input_type(&self) -> ValueType {
        ValueType::Object
    }
    fn output_type(&self) -> ValueType {
        ValueType::Object
    }
    fn effects(&self) -> &'static [&'static str] {
        &[CAP_WORK_GET]
    }
    fn replay(&self) -> EffectReplay {
        EffectReplay::Replayable
    }
    fn execute(&self, input: Value, context: &OperatorContext) -> Result<Value, String> {
        let arc = ArcInput::decode(&input)?;
        let args = json!({
            "channelRef": arc.string("channelRef")?,
            "workId": arc.string("workId")?,
            "requestId": arc.string("requestId")?,
        });
        let response = host_call(self.name(), context, "agentWork.get", args, None)
            .map_err(HostError::into_message)?;
        let reply_control = response.result
            .get("replyControl")
            .cloned()
            .ok_or_else(|| "host result lacks Work reply control".to_owned())?;
        let state = reply_control
            .get("state")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "host Work reply control.state is missing".to_owned())?
            .to_owned();
        let mut control = arc.control.clone();
        control.insert("reply".to_owned(), reply_control);
        control.insert("requestState".to_owned(), Value::String(state));
        Ok(ArcInput {
            control,
            business: response.business,
        }
        .encode())
    }
}

struct ReturnWorkObservation;

impl Operator for ReturnWorkObservation {
    fn name(&self) -> &'static str {
        "teams.return-work-observation"
    }
    fn version(&self) -> &'static str {
        OPERATOR_VERSION
    }
    fn input_type(&self) -> ValueType {
        ValueType::Object
    }
    fn output_type(&self) -> ValueType {
        ValueType::Object
    }
    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let arc = ArcInput::decode(&input)?;
        arc.string("requestState")?;
        let mut control = arc.control.clone();
        control.insert("observed".to_owned(), Value::Bool(true));
        Ok(ArcInput {
            control,
            business: arc.business,
        }
        .encode())
    }
}

/// The one fixed project registry shared by the five Teams Work graphs.
fn registry() -> Registry {
    let mut registry = Registry::default();
    registry
        .register(ResolvePeerService)
        .expect("ResolvePeerService is unique");
    registry
        .register(OpenWorkLink)
        .expect("OpenWorkLink is unique");
    registry
        .register(AdmitProviderWork)
        .expect("AdmitProviderWork is unique");
    registry
        .register(RequestProviderWork)
        .expect("RequestProviderWork is unique");
    registry
        .register(SettleProviderWork)
        .expect("SettleProviderWork is unique");
    registry
        .register(ReturnHeldWork)
        .expect("ReturnHeldWork is unique");
    registry
        .register(ContinueProviderWork)
        .expect("ContinueProviderWork is unique");
    registry
        .register(CloseProviderWork)
        .expect("CloseProviderWork is unique");
    registry
        .register(QueryProviderRequest)
        .expect("QueryProviderRequest is unique");
    registry
        .register(ReturnWorkObservation)
        .expect("ReturnWorkObservation is unique");
    registry
}

struct Options {
    graph: String,
    project_id: Option<String>,
    execution_id: Option<String>,
    attempt_id: Option<String>,
    input: Option<String>,
    capabilities: BTreeSet<String>,
}

fn parse_options(args: &[String]) -> Result<Options, String> {
    let mut graph: Option<String> = None;
    let mut project_id: Option<String> = None;
    let mut execution_id: Option<String> = None;
    let mut attempt_id: Option<String> = None;
    let mut input: Option<String> = None;
    let mut raw_capabilities: Option<String> = None;
    let mut index = 0;
    while index < args.len() {
        let flag = args[index].as_str();
        let value = args
            .get(index + 1)
            .ok_or_else(|| format!("{flag} requires a value"))?;
        match flag {
            "--graph" => graph = Some(value.clone()),
            "--project-id" => project_id = Some(value.clone()),
            "--execution-id" => execution_id = Some(value.clone()),
            "--attempt-id" => attempt_id = Some(value.clone()),
            "--input" => input = Some(value.clone()),
            "--capabilities" => raw_capabilities = Some(value.clone()),
            other => return Err(format!("unknown argument `{other}`")),
        }
        index += 2;
    }
    let capabilities = match raw_capabilities {
        None => DEFAULT_CAPABILITIES
            .iter()
            .map(|name| (*name).to_owned())
            .collect(),
        Some(raw) => {
            let parsed: Value = serde_json::from_str(&raw)
                .map_err(|error| format!("--capabilities is not JSON: {error}"))?;
            let array = parsed
                .as_array()
                .ok_or_else(|| "--capabilities must be a JSON array".to_owned())?;
            let mut set = BTreeSet::new();
            for item in array {
                let value = item
                    .as_str()
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| "--capabilities entries must be non-empty strings".to_owned())?;
                set.insert(value.to_owned());
            }
            set
        }
    };
    Ok(Options {
        graph: graph.ok_or_else(|| "--graph is required".to_owned())?,
        project_id,
        execution_id,
        attempt_id,
        input,
        capabilities,
    })
}

fn read_graph_source(path: &str) -> Result<String, Value> {
    std::fs::read_to_string(path).map_err(|error| {
        json!({
            "type": "compile.failure",
            "stage": "read_graph",
            "graph_path": path,
            "message": format!("graph file is not readable: {error}")
        })
    })
}

fn compile_only(options: &Options) -> Value {
    let source = match read_graph_source(&options.graph) {
        Ok(source) => source,
        Err(frame) => return frame,
    };
    let graph = match parse_graph_json(&source) {
        Ok(graph) => graph,
        Err(error) => {
            return json!({
                "type": "compile.failure",
                "stage": "parse_graph_json",
                "message": error.message
            })
        }
    };
    let graph_id = graph.id.clone();
    let graph_version = graph.version.clone();
    match compile(graph, &registry(), &options.capabilities) {
        Ok(compiled) => json!({
            "type": "compile.result",
            "graph_id": compiled.id(),
            "graph_version": compiled.version(),
            "node_ids": compiled.node_ids().collect::<Vec<_>>(),
            "capabilities": options.capabilities.iter().cloned().collect::<Vec<_>>()
        }),
        Err(error) => json!({
            "type": "compile.failure",
            "stage": "compile",
            "graph_id": graph_id,
            "graph_version": graph_version,
            "message": error.message
        }),
    }
}

fn run_graph(options: &Options) -> Value {
    let source = match read_graph_source(&options.graph) {
        Ok(source) => source,
        Err(frame) => return frame,
    };
    let graph = match parse_graph_json(&source) {
        Ok(graph) => graph,
        Err(error) => {
            return json!({
                "type": "compile.failure",
                "stage": "parse_graph_json",
                "message": error.message
            })
        }
    };
    let graph_id = graph.id.clone();
    let graph_version = graph.version.clone();
    let input_arcs: Vec<String> = graph.inputs.iter().map(|contract| contract.id.clone()).collect();
    let output_arcs: Vec<String> = graph.outputs.clone();
    if input_arcs.len() != 1 {
        return json!({
            "type": "run.failure",
            "message": format!("graph must declare exactly one input ARC, found {}", input_arcs.len())
        });
    }
    let compiled = match compile(graph, &registry(), &options.capabilities) {
        Ok(compiled) => compiled,
        Err(error) => {
            return json!({
                "type": "compile.failure",
                "stage": "compile",
                "graph_id": graph_id,
                "graph_version": graph_version,
                "message": error.message
            })
        }
    };
    let project_id = match &options.project_id {
        Some(value) => value.clone(),
        None => return json!({ "type": "run.failure", "message": "--project-id is required for run" }),
    };
    let execution_id = match &options.execution_id {
        Some(value) => value.clone(),
        None => return json!({ "type": "run.failure", "message": "--execution-id is required for run" }),
    };
    let attempt_id = match &options.attempt_id {
        Some(value) => value.clone(),
        None => return json!({ "type": "run.failure", "message": "--attempt-id is required for run" }),
    };
    let raw_input = match &options.input {
        Some(value) => value,
        None => return json!({ "type": "run.failure", "message": "--input is required for run" }),
    };
    let input: Value = match serde_json::from_str(raw_input) {
        Ok(value) => value,
        Err(error) => {
            return json!({ "type": "run.failure", "message": format!("--input is not JSON: {error}") })
        }
    };
    let identity = Identity {
        project_id,
        graph_id: compiled.id().to_owned(),
        graph_version: compiled.version().to_owned(),
        execution_id,
        attempt_id,
    };
    let runtime_inputs = HashMap::from([(input_arcs[0].clone(), input)]);
    match Runtime::new(options.capabilities.clone()).run(
        &compiled,
        identity,
        runtime_inputs,
        &Cancellation::default(),
    ) {
        Ok(result) => json!({
            "type": "execution.result",
            "identity": result.identity,
            "compiled": {
                "id": compiled.id(),
                "version": compiled.version(),
                "node_ids": compiled.node_ids().collect::<Vec<_>>(),
                "input_arcs": input_arcs,
                "output_arcs": output_arcs
            },
            "outputs": result.outputs,
            "journal": result.journal
        }),
        Err(failure) => json!({
            "type": "execution.failure",
            "kind": failure.error.kind,
            "message": failure.error.message,
            "journal": failure.journal
        }),
    }
}

fn emit(frame: Value) -> ! {
    let encoded = serde_json::to_string(&frame).expect("runner result is serializable");
    write_stdout_line(&encoded).expect("runner result write succeeds");
    std::process::exit(0);
}

fn main() {
    let mut args = std::env::args().skip(1);
    let mode = args.next().unwrap_or_default();
    let rest: Vec<String> = args.collect();
    let frame = match mode.as_str() {
        "compile" | "run" => match parse_options(&rest) {
            Ok(options) => {
                if mode == "compile" {
                    compile_only(&options)
                } else {
                    run_graph(&options)
                }
            }
            Err(message) => json!({ "type": "usage.failure", "message": message }),
        },
        "" => json!({ "type": "usage.failure", "message": "mode is required (compile|run)" }),
        other => json!({ "type": "usage.failure", "message": format!("unknown mode `{other}`") }),
    };
    emit(frame);
}

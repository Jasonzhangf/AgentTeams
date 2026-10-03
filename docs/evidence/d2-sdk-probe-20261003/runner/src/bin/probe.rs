use pipeline_runtime::{
    compile, parse_graph_json, Cancellation, CompiledGraph, EffectReplay, Operator,
    OperatorContext, Registry, Runtime, ValueType,
};
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap};
use std::io::{BufRead, Write};

const GRAPH_ID: &str = "d2_sdk_host_probe";
const INPUT_ARC: &str = "work.intent";
const HOST_EFFECT: &str = "d2.host.read";
const EXECUTION_ID: &str = "d2-probe-execution";

const HOST_GRAPH_JSON: &str = r#"
{
  "id": "d2_sdk_host_probe",
  "version": "1",
  "inputs": [
    { "id": "work.intent", "schema": "Object" }
  ],
  "nodes": [
    {
      "id": "first-host-read",
      "operator": "d2.host_read",
      "operator_version": "1",
      "inputs": ["work.intent"],
      "output": { "id": "host.read", "schema": "Object" },
      "input_selector": { "include": [], "exclude": [] },
      "output_selector": { "include": [], "exclude": [] },
      "iterator": "Whole"
    },
    {
      "id": "second-pure-output",
      "operator": "d2.pure_output",
      "operator_version": "1",
      "inputs": ["host.read"],
      "output": { "id": "work.receipt", "schema": "Object" },
      "input_selector": { "include": [], "exclude": [] },
      "output_selector": { "include": [], "exclude": [] },
      "iterator": "Whole"
    }
  ],
  "edges": [
    {
      "from": "first-host-read",
      "to": "second-pure-output",
      "arc_id": "host.read"
    }
  ],
  "outputs": ["work.receipt"]
}
"#;

const MISSING_OPERATOR_GRAPH_JSON: &str = r#"
{
  "id": "d2_sdk_host_probe",
  "version": "1",
  "inputs": [
    { "id": "work.intent", "schema": "Object" }
  ],
  "nodes": [
    {
      "id": "first-host-read",
      "operator": "d2.missing_operator",
      "operator_version": "1",
      "inputs": ["work.intent"],
      "output": { "id": "host.read", "schema": "Object" },
      "input_selector": { "include": [], "exclude": [] },
      "output_selector": { "include": [], "exclude": [] },
      "iterator": "Whole"
    },
    {
      "id": "second-pure-output",
      "operator": "d2.pure_output",
      "operator_version": "1",
      "inputs": ["host.read"],
      "output": { "id": "work.receipt", "schema": "Object" },
      "input_selector": { "include": [], "exclude": [] },
      "output_selector": { "include": [], "exclude": [] },
      "iterator": "Whole"
    }
  ],
  "edges": [
    {
      "from": "first-host-read",
      "to": "second-pure-output",
      "arc_id": "host.read"
    }
  ],
  "outputs": ["work.receipt"]
}
"#;

struct HostReadOperator;

impl Operator for HostReadOperator {
    fn name(&self) -> &'static str {
        "d2.host_read"
    }

    fn version(&self) -> &'static str {
        "1"
    }

    fn input_type(&self) -> ValueType {
        ValueType::Object
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn effects(&self) -> &'static [&'static str] {
        &[HOST_EFFECT]
    }

    fn replay(&self) -> EffectReplay {
        EffectReplay::Idempotent
    }

    fn execute(&self, input: Value, context: &OperatorContext) -> Result<Value, String> {
        let path = input
            .get("path")
            .and_then(Value::as_str)
            .filter(|path| !path.is_empty())
            .ok_or_else(|| "business.path must be a non-empty string".to_owned())?;
        host_read(path, context)
    }
}

struct PureOutputOperator;

impl Operator for PureOutputOperator {
    fn name(&self) -> &'static str {
        "d2.pure_output"
    }

    fn version(&self) -> &'static str {
        "1"
    }

    fn input_type(&self) -> ValueType {
        ValueType::Object
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        Ok(input)
    }
}

fn host_read(path: &str, context: &OperatorContext) -> Result<Value, String> {
    let request_id = format!(
        "{}/{}/{}",
        context.identity.execution_id, context.node_id, context.identity.attempt_id
    );
    let request = json!({
        "type": "host.call",
        "control": {
            "request_id": request_id,
            "operation": "host.read_file",
            "operator": "d2.host_read",
            "node_id": context.node_id,
            "identity": &context.identity
        },
        "business": {
            "path": path
        }
    });
    let encoded =
        serde_json::to_string(&request).map_err(|error| format!("host call encode failed: {error}"))?;

    {
        let stdout = std::io::stdout();
        let mut output = stdout.lock();
        writeln!(output, "{encoded}").map_err(|error| format!("host call write failed: {error}"))?;
        output
            .flush()
            .map_err(|error| format!("host call flush failed: {error}"))?;
    }

    let stdin = std::io::stdin();
    let mut input = stdin.lock();
    let mut line = String::new();
    let read = input
        .read_line(&mut line)
        .map_err(|error| format!("host response read failed: {error}"))?;
    if read == 0 {
        return Err("host EOF before host.result/host.error".to_owned());
    }

    let response: Value = serde_json::from_str(line.trim_end())
        .map_err(|error| format!("host response is not JSON: {error}"))?;
    let control = response
        .get("control")
        .and_then(Value::as_object)
        .ok_or_else(|| "host response lacks control object".to_owned())?;
    let response_request_id = control
        .get("request_id")
        .and_then(Value::as_str)
        .ok_or_else(|| "host response lacks control.request_id".to_owned())?;
    if response_request_id != request_id {
        return Err(format!(
            "host response correlation mismatch: expected `{request_id}`, got `{response_request_id}`"
        ));
    }

    match response.get("type").and_then(Value::as_str) {
        Some("host.result") => {
            if control.get("status").and_then(Value::as_str) != Some("ok") {
                return Err("host.result control.status is not `ok`".to_owned());
            }
            response
                .get("business")
                .cloned()
                .ok_or_else(|| "host.result lacks business object".to_owned())
        }
        Some("host.error") => {
            if control.get("status").and_then(Value::as_str) != Some("error") {
                return Err("host.error control.status is not `error`".to_owned());
            }
            let message = response
                .get("business")
                .and_then(|business| business.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("host reported an error");
            Err(message.to_owned())
        }
        Some(other) => Err(format!("unsupported host response type `{other}`")),
        None => Err("host response lacks type".to_owned()),
    }
}

fn registry() -> Registry {
    let mut registry = Registry::default();
    registry
        .register(HostReadOperator)
        .expect("HostReadOperator registration is unique");
    registry
        .register(PureOutputOperator)
        .expect("PureOutputOperator registration is unique");
    registry
}

fn capabilities(include_host_effect: bool) -> BTreeSet<String> {
    if include_host_effect {
        BTreeSet::from([HOST_EFFECT.to_owned()])
    } else {
        BTreeSet::new()
    }
}

fn compile_graph(
    graph_json: &str,
    capabilities: &BTreeSet<String>,
) -> Result<CompiledGraph, Value> {
    let graph = parse_graph_json(graph_json).map_err(|error| {
        json!({
            "probe": "d2-sdk-probe",
            "status": "compile_error",
            "stage": "parse_graph_json",
            "message": error.message
        })
    })?;
    compile(graph, &registry(), capabilities).map_err(|error| {
        json!({
            "probe": "d2-sdk-probe",
            "status": "compile_error",
            "stage": "compile",
            "graph_id": GRAPH_ID,
            "message": error.message
        })
    })
}

fn run_graph(input: Value, capabilities: BTreeSet<String>) -> Value {
    let compiled = match compile_graph(HOST_GRAPH_JSON, &capabilities) {
        Ok(compiled) => compiled,
        Err(frame) => return frame,
    };
    let identity = pipeline_runtime::Identity {
        project_id: "agentteams-d2-probe".to_owned(),
        graph_id: compiled.id().to_owned(),
        graph_version: compiled.version().to_owned(),
        execution_id: EXECUTION_ID.to_owned(),
        attempt_id: "1".to_owned(),
    };
    let runtime_inputs = HashMap::from([(INPUT_ARC.to_owned(), input.clone())]);
    match Runtime::new(capabilities).run(
        &compiled,
        identity,
        runtime_inputs,
        &Cancellation::default(),
    ) {
        Ok(result) => json!({
            "probe": "d2-sdk-probe",
            "status": "success",
            "identity": result.identity,
            "compiled": {
                "id": compiled.id(),
                "version": compiled.version(),
                "node_ids": compiled.node_ids().collect::<Vec<_>>()
            },
            "graph_input": input,
            "outputs": result.outputs,
            "journal": result.journal
        }),
        Err(failure) => json!({
            "probe": "d2-sdk-probe",
            "status": "runtime_error",
            "kind": failure.error.kind,
            "message": failure.error.message,
            "journal": failure.journal
        }),
    }
}

fn emit(frame: Value) -> ! {
    let encoded = serde_json::to_string(&frame).expect("probe result is serializable");
    let stdout = std::io::stdout();
    let mut output = stdout.lock();
    writeln!(output, "{encoded}").expect("probe result write succeeds");
    output.flush().expect("probe result flush succeeds");
    std::process::exit(0);
}

fn main() {
    let mut args = std::env::args().skip(1);
    let mode = args.next().unwrap_or_else(|| "help".to_owned());
    let frame = match mode.as_str() {
        "run" => {
            let raw = args.next().unwrap_or_else(|| "{}".to_owned());
            match serde_json::from_str::<Value>(&raw) {
                Ok(input) => run_graph(input, capabilities(true)),
                Err(error) => json!({
                    "probe": "d2-sdk-probe",
                    "status": "usage_error",
                    "message": format!("run input is not JSON: {error}")
                }),
            }
        }
        "compile-missing-operator" => match compile_graph(
            MISSING_OPERATOR_GRAPH_JSON,
            &capabilities(true),
        ) {
            Ok(_) => json!({
                "probe": "d2-sdk-probe",
                "status": "unexpected_success",
                "message": "missing-operator graph unexpectedly compiled"
            }),
            Err(frame) => frame,
        },
        "compile-missing-effects" => {
            match compile_graph(HOST_GRAPH_JSON, &capabilities(false)) {
                Ok(_) => json!({
                    "probe": "d2-sdk-probe",
                    "status": "unexpected_success",
                    "message": "missing-effects graph unexpectedly compiled"
                }),
                Err(frame) => frame,
            }
        }
        other => json!({
            "probe": "d2-sdk-probe",
            "status": "usage_error",
            "message": format!("unknown mode `{other}`")
        }),
    };
    emit(frame)
}

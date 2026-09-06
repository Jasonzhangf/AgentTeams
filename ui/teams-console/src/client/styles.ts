export const teamsStyles = String.raw`
:root {
  --teams-ink: oklch(0.93 0.02 250);
  --teams-muted: oklch(0.72 0.04 250);
  --teams-faint: oklch(0.58 0.04 250);
  --teams-surface: oklch(0.18 0.04 255);
  --teams-surface-raised: oklch(0.23 0.045 255);
  --teams-surface-soft: oklch(0.26 0.05 255);
  --teams-border: oklch(0.38 0.055 255);
  --teams-accent: oklch(0.74 0.14 230);
  --teams-accent-strong: oklch(0.66 0.16 230);
  --teams-success: oklch(0.76 0.14 155);
  --teams-warning: oklch(0.8 0.14 85);
  --teams-danger: oklch(0.72 0.16 25);
  --teams-radius: 14px;
  --teams-motion-in: cubic-bezier(0.2, 0, 0, 1);
  --teams-motion-out: cubic-bezier(0.4, 0, 0.2, 1);
}

.teams-root,
.teams-root * {
  box-sizing: border-box;
}

.teams-root {
  color: var(--teams-ink);
  font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 15px;
  line-height: 1.5;
  font-variant-numeric: tabular-nums;
}

.teams-root button,
.teams-root input,
.teams-root select,
.teams-root textarea {
  font: inherit;
}

.teams-launch,
.teams-root button {
  min-height: 34px;
}

.teams-launch,
.teams-button,
.teams-tab,
.teams-icon-button,
.teams-list-item,
.teams-provider-card {
  cursor: pointer;
}

.teams-launch {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  padding: 9px 14px;
  border: 1px solid var(--teams-border);
  border-radius: 10px;
  color: var(--teams-ink);
  background: var(--teams-surface);
  box-shadow: 0 10px 28px oklch(0.06 0.03 255 / 0.24);
}

.teams-launch::before {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--teams-accent);
  content: "";
}

.teams-overlay {
  position: fixed;
  z-index: 1000;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 24px;
}

.teams-backdrop {
  position: absolute;
  inset: 0;
  background: oklch(0.06 0.03 255 / 0.78);
}

.teams-panel {
  position: relative;
  display: flex;
  flex-direction: column;
  width: min(1180px, 100%);
  max-height: min(900px, 100%);
  overflow: hidden;
  border: 1px solid var(--teams-border);
  border-radius: 18px;
  background: var(--teams-surface);
  box-shadow: 0 28px 90px oklch(0.04 0.03 255 / 0.52);
}

.teams-panel.is-expanded {
  width: 100%;
  max-height: 100%;
  border-radius: 0;
}

.teams-header,
.teams-view-header,
.teams-card-header,
.teams-provider-header,
.teams-config-toolbar,
.teams-drawer-header,
.teams-footer-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
}

.teams-header {
  flex: 0 0 auto;
  padding: 18px 22px;
  border-bottom: 1px solid var(--teams-border);
}

.teams-brand {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.teams-brand strong {
  font-size: 17px;
  letter-spacing: -0.02em;
}

.teams-brand span,
.teams-subtitle,
.teams-muted,
.teams-agent-meta,
.teams-list-secondary,
.teams-provider-meta,
.teams-field-hint {
  color: var(--teams-muted);
}

.teams-brand span,
.teams-subtitle,
.teams-list-secondary,
.teams-provider-meta,
.teams-field-hint {
  font-size: 13px;
}

.teams-header-actions,
.teams-button-row,
.teams-card-actions,
.teams-list-actions,
.teams-provider-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.teams-button,
.teams-icon-button,
.teams-tab,
.teams-input,
.teams-select,
.teams-textarea {
  border: 1px solid var(--teams-border);
  border-radius: 9px;
  color: var(--teams-ink);
  background: var(--teams-surface-raised);
}

.teams-button,
.teams-icon-button {
  padding: 8px 12px;
}

.teams-button-primary {
  border-color: var(--teams-accent-strong);
  background: var(--teams-accent-strong);
  color: oklch(0.15 0.04 255);
  font-weight: 700;
}

.teams-button-secondary,
.teams-icon-button {
  background: transparent;
}

.teams-button-danger {
  border-color: var(--teams-danger);
  color: oklch(0.9 0.04 25);
}

.teams-button:disabled,
.teams-icon-button:disabled,
.teams-select:disabled,
.teams-input:disabled,
.teams-textarea:disabled {
  cursor: not-allowed;
  opacity: 0.52;
}

.teams-tabs {
  display: flex;
  flex: 0 0 auto;
  gap: 4px;
  padding: 8px 18px 0;
  overflow-x: auto;
  border-bottom: 1px solid var(--teams-border);
}

.teams-tab {
  flex: 0 0 auto;
  padding: 10px 12px;
  border: 0;
  border-bottom: 2px solid transparent;
  border-radius: 0;
  color: var(--teams-muted);
  background: transparent;
}

.teams-tab.is-active {
  border-bottom-color: var(--teams-accent);
  color: var(--teams-ink);
  font-weight: 700;
}

.teams-content {
  min-height: 420px;
  overflow: auto;
  padding: 26px;
}

.teams-view-header {
  align-items: flex-start;
  margin-bottom: 22px;
}

.teams-view-title {
  margin: 0;
  font-size: clamp(20px, 2.2vw, 28px);
  line-height: 1.2;
  letter-spacing: -0.03em;
  text-wrap: balance;
}

.teams-subtitle {
  max-width: 68ch;
  margin: 7px 0 0;
  text-wrap: pretty;
}

.teams-status-pill,
.teams-catalog-state,
.teams-revision {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
  padding: 5px 9px;
  border: 1px solid var(--teams-border);
  border-radius: 999px;
  color: var(--teams-muted);
  font-size: 12px;
  white-space: nowrap;
}

.teams-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
}

.teams-agent-card,
.teams-provider-card,
.teams-list-item,
.teams-empty,
.teams-error-panel,
.teams-memory-panel {
  border: 1px solid var(--teams-border);
  border-radius: var(--teams-radius);
  background: var(--teams-surface-raised);
}

.teams-agent-card,
.teams-provider-card {
  display: grid;
  gap: 16px;
  min-width: 0;
  padding: 17px;
}

.teams-card-header,
.teams-provider-header {
  align-items: flex-start;
}

.teams-identity {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.teams-identity-copy {
  display: grid;
  min-width: 0;
  gap: 2px;
}

.teams-identity-copy strong,
.teams-list-primary,
.teams-provider-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.teams-identity-copy span {
  overflow: hidden;
  color: var(--teams-muted);
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.teams-presence {
  width: 10px;
  height: 10px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: var(--teams-faint);
}

.teams-presence-online { background: var(--teams-success); }
.teams-presence-offline { background: var(--teams-danger); }
.teams-presence-unknown { background: var(--teams-warning); }

.teams-agent-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 7px 12px;
  font-size: 13px;
}

.teams-agent-meta span {
  min-width: 0;
  overflow-wrap: anywhere;
}

.teams-agent-meta strong {
  color: var(--teams-ink);
  font-weight: 650;
}

.teams-card-actions .teams-button-primary {
  flex: 1 1 auto;
}

.teams-list {
  display: grid;
  gap: 10px;
}

.teams-list-item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 14px;
  width: 100%;
  padding: 14px 16px;
  text-align: start;
}

.teams-list-item:hover,
.teams-list-item:focus-visible,
.teams-provider-card:hover {
  border-color: var(--teams-accent);
}

.teams-list-main {
  display: grid;
  min-width: 0;
  gap: 4px;
}

.teams-list-secondary {
  overflow-wrap: anywhere;
}

.teams-list-actions {
  justify-content: flex-end;
}

.teams-notification-pending {
  border-color: var(--teams-warning);
}

.teams-notification-kind {
  color: var(--teams-warning);
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
}

.teams-search {
  width: 100%;
  max-width: 680px;
  margin-bottom: 18px;
}

.teams-input,
.teams-select,
.teams-textarea {
  width: 100%;
  padding: 10px 12px;
}

.teams-input,
.teams-select {
  min-height: 42px;
}

.teams-textarea {
  min-height: 96px;
  resize: vertical;
}

.teams-field-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

.teams-field {
  display: grid;
  gap: 6px;
  min-width: 0;
}

.teams-field-full {
  grid-column: 1 / -1;
}

.teams-field label {
  color: var(--teams-ink);
  font-size: 13px;
  font-weight: 650;
}

.teams-field-hint {
  line-height: 1.4;
}

.teams-checkbox {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 42px;
}

.teams-checkbox input {
  width: 18px;
  height: 18px;
}

.teams-config-toolbar {
  align-items: flex-end;
  margin-bottom: 18px;
}

.teams-config-toolbar .teams-field {
  width: min(360px, 100%);
}

.teams-revision-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 18px;
}

.teams-revision strong {
  color: var(--teams-ink);
}

.teams-provider-list {
  display: grid;
  gap: 12px;
}

.teams-provider-title {
  margin: 0;
  font-size: 16px;
}

.teams-provider-meta {
  overflow-wrap: anywhere;
}

.teams-provider-details {
  display: grid;
  gap: 12px;
}

.teams-model-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 10px;
  align-items: end;
  padding-top: 12px;
  border-top: 1px solid var(--teams-border);
}

.teams-catalog-state.is-ready { color: var(--teams-success); }
.teams-catalog-state.is-empty { color: var(--teams-warning); }
.teams-catalog-state.is-error { color: var(--teams-danger); }

.teams-memory-panel,
.teams-empty,
.teams-error-panel,
.teams-loading {
  padding: 22px;
}

.teams-empty,
.teams-loading {
  color: var(--teams-muted);
  text-align: center;
}

.teams-error-panel {
  display: grid;
  gap: 12px;
  border-color: var(--teams-danger);
}

.teams-error-panel strong {
  color: oklch(0.9 0.05 25);
}

.teams-live-region {
  min-height: 22px;
  padding: 0 26px 12px;
  color: var(--teams-success);
  font-size: 13px;
}

.teams-live-region.is-error {
  color: oklch(0.9 0.05 25);
}

.teams-fixture-label {
  position: fixed;
  right: 12px;
  bottom: 12px;
  z-index: 1100;
  max-width: calc(100% - 24px);
  padding: 7px 10px;
  border: 1px solid var(--teams-warning);
  border-radius: 8px;
  color: var(--teams-warning);
  background: var(--teams-surface);
  font-size: 12px;
}

.teams-drawer-layer {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.teams-drawer {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  display: flex;
  flex-direction: column;
  max-height: 82%;
  overflow: hidden;
  border-top: 1px solid var(--teams-border);
  border-radius: 18px 18px 0 0;
  background: var(--teams-surface-soft);
  box-shadow: 0 -20px 50px oklch(0.04 0.03 255 / 0.42);
  pointer-events: auto;
  transform: translateY(0);
}

.teams-drawer.is-expanded {
  max-height: 100%;
  border-radius: 0;
}

.teams-drawer-header {
  flex: 0 0 auto;
  align-items: flex-start;
  padding: 14px 18px;
  touch-action: none;
  user-select: none;
}

.teams-drawer-grip {
  width: 34px;
  height: 4px;
  margin-top: 7px;
  border-radius: 999px;
  background: var(--teams-muted);
}

.teams-drawer-heading {
  display: grid;
  min-width: 0;
  gap: 2px;
}

.teams-drawer-heading span {
  color: var(--teams-muted);
  font-size: 13px;
}

.teams-drawer-body {
  min-height: 240px;
  overflow: auto;
  padding: 22px;
  border-top: 1px solid var(--teams-border);
}

.teams-composer,
.teams-config-form {
  display: grid;
  gap: 16px;
  max-width: 760px;
}

.teams-composer h3,
.teams-config-form h3 {
  margin: 0;
  font-size: 20px;
  letter-spacing: -0.02em;
}

.teams-composer p {
  margin: 0;
  max-width: 68ch;
  color: var(--teams-muted);
}

.teams-root :where(button, input, select, textarea):focus-visible {
  outline: 2px solid var(--teams-accent);
  outline-offset: 2px;
}

.teams-root ::selection {
  color: oklch(0.15 0.04 255);
  background: var(--teams-accent);
}

@media (pointer: coarse) {
  .teams-root button,
  .teams-root select,
  .teams-root input[type="checkbox"] {
    min-height: 44px;
  }
}

@media (max-width: 780px) {
  .teams-overlay {
    place-items: end stretch;
    padding: 0;
  }

  .teams-panel {
    width: 100%;
    max-height: 100%;
    border: 0;
    border-radius: 0;
  }

  .teams-header {
    padding: 14px 16px;
  }

  .teams-header .teams-brand span {
    display: none;
  }

  .teams-content {
    min-height: 0;
    padding: 20px 16px 28px;
  }

  .teams-view-header,
  .teams-config-toolbar {
    align-items: flex-start;
    flex-direction: column;
  }

  .teams-grid,
  .teams-field-grid {
    grid-template-columns: 1fr;
  }

  .teams-field-full {
    grid-column: auto;
  }

  .teams-list-item {
    grid-template-columns: 1fr;
    align-items: start;
  }

  .teams-list-actions {
    justify-content: flex-start;
  }

  .teams-model-row {
    grid-template-columns: 1fr;
  }

  .teams-drawer {
    max-height: 92%;
  }

  .teams-drawer-header,
  .teams-drawer-body {
    padding-inline: 16px;
  }

  .teams-live-region {
    padding-inline: 16px;
  }
}

@media (forced-colors: active) {
  .teams-root :where(button, input, select, textarea):focus-visible {
    outline: 2px solid CanvasText;
  }
}
`

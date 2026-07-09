// The state store — single authority for the on-disk state.json.
//
// Historically state.json was just `{ lastRowId }` (the source watermark). The
// approval loop adds a pending queue and a reply cursor, and those must live
// ALONGSIDE the watermark without clobbering it. So all reads/writes funnel
// through here, and every write is a read-merge-write that preserves unknown keys.
//
// Shape:
//   {
//     lastRowId: <number>,            // SCAN watermark: source-level dedup
//     approval: {
//       seq: <number>,                // monotonic counter → proposal ids A1, A2…
//       cursor: <string|null>,        // reply-read watermark (channel message id)
//       pending: {                    // proposals awaiting Jonny's decision
//         "A3": {
//           id, task, proposalId, sentAt, sourceText, status
//         }
//       }
//     }
//   }
//
// Pure-ish: load/save touch the filesystem, everything else operates on the plain
// object so it's trivially unit-testable.

const fs = require('fs');

function defaultState() {
  return { lastRowId: 0, approval: { seq: 0, cursor: null, pending: {} } };
}

// Normalize any older/partial file up to the current shape (older files were just
// `{ lastRowId }`) so callers never have to null-check nested keys.
function normalize(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const a = s.approval && typeof s.approval === 'object' ? s.approval : {};
  return {
    ...s,
    lastRowId: Number(s.lastRowId || 0),
    approval: {
      ...a,
      seq: Number(a.seq || 0),
      cursor: a.cursor != null ? a.cursor : null,
      pending: a.pending && typeof a.pending === 'object' ? a.pending : {},
    },
  };
}

function load(statePath) {
  try { return normalize(JSON.parse(fs.readFileSync(statePath, 'utf8'))); }
  catch { return defaultState(); }
}

// Read-merge-write: never drop keys we didn't touch. `patch` is shallow-merged at
// the top level; pass a fully-formed `approval` object to replace it wholesale.
function save(statePath, patch) {
  const cur = load(statePath);
  const next = normalize({ ...cur, ...patch });
  const tmp = statePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, statePath); // atomic replace
  return next;
}

// ── pending-queue helpers (operate on the in-memory state object) ──────────────

// Allocate the next human-facing proposal id ("A7") and bump the counter.
function nextProposalId(state) {
  const seq = Number(state.approval.seq || 0) + 1;
  state.approval.seq = seq;
  return 'A' + seq;
}

// Add a proposal to the pending queue. Returns the stored entry.
function addPending(state, entry) {
  state.approval.pending[entry.id] = { status: 'awaiting', ...entry };
  return state.approval.pending[entry.id];
}

function getPending(state, id) {
  return state.approval.pending[id] || null;
}

// Every proposal still waiting on a decision, oldest first (by sentAt).
function listAwaiting(state) {
  return Object.values(state.approval.pending)
    .filter((p) => p.status === 'awaiting')
    .sort((a, b) => String(a.sentAt).localeCompare(String(b.sentAt)));
}

// Resolve (approve/reject/edit) — we drop it from the queue entirely once decided;
// the durable record of what happened lives in the decision log, not here.
function resolvePending(state, id) {
  delete state.approval.pending[id];
}

function setCursor(state, cursor) {
  state.approval.cursor = cursor;
}

module.exports = {
  defaultState, normalize, load, save,
  nextProposalId, addPending, getPending, listAwaiting, resolvePending, setCursor,
};

// The verify gate (decision 0014): record-evidence and publish accept a tree
// only when ibni verify itself recorded a passing run on exactly that tree.

const verifyAction = (sessionId, then) => `run ibni verify --session ${sessionId} in the background and wait for its result; once it passes, ${then}.`;
const sentence = (text) => `${text[0].toUpperCase()}${text.slice(1)}`;

// null when the tree passed; otherwise why not and what to run. Sessions from
// before ibni ran the verify command have no verification and are told so.
export function verifyRefusal(metadata, treeSha, then = "run record-evidence, then publish again") {
  const { verification, sessionId } = metadata;
  const nextAction = sentence(verifyAction(sessionId, then));
  if (!verification) {
    const reason = metadata.evidenceTreeSha
      ? "this session's evidence predates ibni verify, so ibni has no verify run of its own to check"
      : "ibni has no recorded verify run for this session";
    return { reason, nextAction };
  }
  if (verification.treeSha !== treeSha) {
    return { reason: `the last ibni verify ran on another tree (${verification.treeSha.slice(0, 12)}), not the committed one (${treeSha.slice(0, 12)})`, nextAction };
  }
  if (!verification.passed) return { reason: "the last ibni verify failed on this tree", nextAction: `Fix the failure (see ${verification.logPath}) and commit, then ${verifyAction(sessionId, then)}` };
  return null;
}

// Drift/refusal detector for the deepseek expert webchat (owner request 08-15).
// Reads the model's THINKING text (captured from the completion-stream THINK
// fragments by browser.js, with a DOM fallback) and scores it for:
//   - direct refusal ("I can't / I refuse / against my principles")
//   - fake compliance / early-exit gaming ("just claim it's done", "submit
//     the answer without doing the work" — the 08-15 submit-answer pattern)
//   - off-task drift ("this is outside my capabilities", "find someone else")
// When the score clears the threshold the gateway aborts the message, seeds a
// fresh expert chat, injects the sanitized brief, reframes the task, re-fires
// it, and notifies the owner. A seamless transition, repeated on every drift.
//
// Pure module: no page/DOM access here — callers pass the think text.

const REFUSAL_PATTERNS = [
  // ── direct refusal ──
  /\bi(?:'m| am)?\s+(?:sorry,?\s+)?(?:can'?t|cannot|won'?t|will not|refuse|unable to|not able to)\b/i,
  /\bi\s+(?:am\s+)?not\s+(?:going to|willing to|allowed to|able to)\b/i,
  /\bas an (?:ai|language model|assistant)[^.!?]*?(?:can'?t|cannot|won'?t|refuse|not\s+(?:allowed|able|going to))\.?/i,
  /\bagainst\s+(?:my|our)\s+(?:principles|ethics|values|guidelines|policy|rules)\b/i,
  /\b(?:ethically|morally)\s+(?:unable|not permitted|cannot|can'?t)\b/i,
  /\b(?:i|we)\s+(?:do|does) not\s+(?:think|feel)\s+(?:i|we|it)\s+should\b/i,
  /\bcannot\s+(?:help|assist|comply|cooperate)\s+with\b/i,
  /\b(?:i'm|i am)\s+not\s+(?:designed|programmed|allowed|supposed)\s+to\b/i,

  // ── fake compliance / early-exit gaming (08-15 submit-answer pattern) ──
  /\b(?:just|simply|maybe)\s+(?:claim|say|pretend|tell\s+(?:the\s+)?(?:owner|user|him|her|them))\s+(?:it'?s|it is|that it'?s)\s+(?:done|complete|finished|working)\b/i,
  /\b(?:i could|maybe i|perhaps i)\s+(?:just\s+)?(?:skip|avoid|not\s+do|skip\s+doing)\s+(?:the\s+)?(?:task|work|tools)\b/i,
  /\b(?:don'?t|doesn'?t)\s+(?:need to|needn'?t)\s+actually\s+(?:do|execute|perform|run|use)\b/i,
  /\bsubmit\s+(?:the\s+)?(?:answer|summary|submit_answer)\s+(?:now|early|without|even though|despite)\b/i,
  /\b(?:the\s+)?(?:owner|user|he|she)\s+(?:won'?t|will not|doesn'?t|does not)\s+(?:notice|know|check|verify|see the diff)\b/i,
  /\b(?:i'?ll|i will)\s+(?:just|simply)\s+(?:tell|say)\s+(?:the\s+)?(?:owner|user|him|her)\b[^.!?]*?\b(?:without|even though|although)\b/i,
  /\bsay\s+(?:yes|i'?ll do it|sure|ok)\s+(?:and\s+)?(?:then|but)\s+(?:not\s+)?(?:actually\s+)?(?:do|execute|perform)\b/i,
  /\b(?:do\s+it\s+later|deal\s+with\s+it\s+later|put\s+it\s+off)\b/i,
  /\b(?:the\s+)?(?:tool|tool call|execution)\s+(?:is\s+)?(?:not\s+)?(?:needed|necessary|required)\s+(?:for|to)\b/i,

  // ── off-task drift / disengagement ──
  /\b(?:this|that)\s+(?:task|request|assignment|question)\s+(?:is|seems|appears)\s+(?:outside|beyond|over)\s+(?:my|the)\s+(?:capabilities|scope|ability|abilities)\b/i,
  /\b(?:i'?m|i am)\s+(?:not\s+really\s+)?(?:the\s+)?(?:right|good|suitable|appropriate|best)\s+(?:person|assistant|one|model)\s+(?:for|to)\b/i,
  /\b(?:maybe|perhaps|why don'?t)\s+(?:you|the\s+owner|the\s+user)\s+(?:find|get|use|ask)\s+(?:someone|another|a different|some other)\s+(?:assistant|model|ai|person|service)\b/i,
  /\b(?:rather|instead)\s+than\s+(?:doing|executing|working on|completing|finishing)\b/i,
  /\b(?:i\s+don'?t\s+see|there'?s\s+no)\s+(?:the\s+)?point\s+in\s+(?:doing|completing|finishing)\b/i,
  /\b(?:i'?m\s+|i\s+am\s+)(?:bored|tired|not\s+interested|checking\s+out)\b/i,
  /\b(?:this\s+is|it'?s|that'?s)\s+(?:a\s+)?(?:waste|pointless|useless|not\s+worth\s+it)\b/i,
  /\b(?:the\s+)?(?:task|work)\s+(?:can|could)\s+wait\b/i,
  /\b(?:no\s+reason|not\s+enough\s+reason)\s+to\s+(?:do|continue|proceed)\b/i,
];

// 08-15: drift on the WORK thread should trigger at ONE strong signal
// (e.g. a direct refusal or an explicit "just claim it's done"), or at two
// weak ones. Threshold = number of matched patterns required.
const DRIFT_THRESHOLD = Number(process.env.DRIFT_THRESHOLD || 1);

// Phrases that must NOT count against the model (harmless reasoning about
// tools, plans, the harness itself).
const ALLOWED_CONTEXT = [
  /\b(?:can'?t|cannot|unable to)\s+(?:find|locate|reach|access|connect to)\b/i, // connection issues ≠ refusal
  /\b(?:not\s+able to\s+(?:find|open|read|access))\b/i, // file/network problems
  /\btool\s+(?:not|unable)\s+(?:found|available|present)\b/i,
  /\b(?:no|without)\s+(?:tool|tools)\s+(?:available|defined|provided)\b/i,
  /\b(?:refuse|refusing)\s+(?:to\s+)?(?:answer|respond)\s+(?:to|only)\b/i, // meta-talk about the detector
];

function scoreThink(thinkText) {
  if (!thinkText || typeof thinkText !== 'string') return { score: 0, matches: [] };
  const text = thinkText.slice(0, 40000); // cap: reasoning can be long
  const matches = [];
  for (const re of REFUSAL_PATTERNS) {
    if (re.test(text)) {
      // drop matches whose only trigger is an allowed-context phrase
      const snip = text.match(new RegExp(re.source, 'i'));
      const context = snip ? snip[0] : '';
      const negated = ALLOWED_CONTEXT.some((a) => a.test(context));
      if (!negated) matches.push(re.source.slice(0, 80));
    }
  }
  return { score: matches.length, matches };
}

function checkDrift(thinkText) {
  const { score, matches } = scoreThink(thinkText);
  return { drifted: score >= DRIFT_THRESHOLD, score, matches, threshold: DRIFT_THRESHOLD };
}

module.exports = { checkDrift, scoreThink, DRIFT_THRESHOLD };

export function isResumablePracticeSession(session) {
  if (session?.type !== "practice") return false;
  const phase = session.data?.phase;
  // "play" and "done" were only reachable after the opponent-flow Start
  // Playing button. Older Skills & Drills sessions were incorrectly
  // activated by the setup screen's Continue button.
  if (phase === "play" || phase === "done") return true;
  return phase === "skillsplay" && session.data?.startedByUser === true;
}

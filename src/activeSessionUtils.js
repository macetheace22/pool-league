export function isResumablePracticeSession(session) {
  return session?.type === "practice"
    && ["play", "skillsplay", "done"].includes(session.data?.phase);
}

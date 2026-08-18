/**
 * dsh-lamp state machine — pure functions, no I/O, fully unit-testable.
 *
 * Maps DeepSeek Harness session-log events to the codex-lamp vocabulary:
 *   off | idle | working | input
 *
 * Semantics mirror codex-lamp's aggregation: with concurrent sessions the
 * highest-priority state wins (input > working > idle > off by default).
 */

export const STATES = Object.freeze({
  OFF: 'off',
  IDLE: 'idle',
  WORKING: 'working',
  INPUT: 'input',
});

/** Default priority order — index 0 is the highest priority. */
export const DEFAULT_PRIORITY = Object.freeze([
  STATES.INPUT,
  STATES.WORKING,
  STATES.IDLE,
  STATES.OFF,
]);

/** Rank of a state in the priority list, or -1 when unknown. */
export function priorityIndex(priority, state) {
  const index = priority.indexOf(state);
  return index;
}

/**
 * Reduce one session event into that session's next state.
 *
 * @param current - the session's current state ('' for a fresh session).
 * @param event - a DSH session-log event (`{ type, data }`).
 * @param priority - optional priority list (used only to sanity-rank transitions).
 * @returns the next state string, or `null` when the session should be
 *   dropped from tracking (the session ended).
 */
export function reduceSession(current, event, priority = DEFAULT_PRIORITY) {
  const type = event && typeof event === 'object' ? event.type : undefined;
  const data = event && typeof event === 'object' && event.data ? event.data : {};
  switch (type) {
    // A human queued a prompt (the agent is about to start / is starting).
    case 'agent/inbox/spliced': {
      const userQueued = Array.isArray(data.inserted)
        && data.inserted.some((message) => message && message.source && message.source.kind === 'user');
      return userQueued ? STATES.WORKING : current;
    }
    // Agent begins a turn or a step.
    case 'turn/start':
    case 'step/start':
      return STATES.WORKING;
    // Tool activity keeps the lamp on `working`; asking the human a question
    // parks the turn until the answer arrives, which is `input`.
    case 'tool/call':
      return data.name === 'ask_user_question' ? STATES.INPUT : STATES.WORKING;
    // The agent asked the user for permission / an answer.
    case 'approval/asked':
      return STATES.INPUT;
    // The user answered; the open turn resumes.
    case 'approval/decided':
      return STATES.WORKING;
    // A slash command was dispatched (user-driven work).
    case 'command/run':
      return STATES.WORKING;
    // A turn completed -> back to idle (debounced by the plugin layer).
    case 'turn/end':
      return STATES.IDLE;
    // The session is over: stop tracking it.
    case 'session/end-seed':
      return null;
    default:
      return current;
  }
}

/**
 * Aggregate a map of `{ sessionId -> state | null }` into one overall state.
 * The highest-priority tracked state wins; untracked/unknown states are
 * ignored; an empty map yields `off` (the lowest priority).
 */
export function aggregate(sessions, priority = DEFAULT_PRIORITY) {
  let bestRank = priority.length;
  let bestState = STATES.OFF;
  for (const state of Object.values(sessions)) {
    if (state === null || state === undefined) continue;
    const rank = priorityIndex(priority, state);
    if (rank === -1) continue;
    if (rank < bestRank) {
      bestRank = rank;
      bestState = state;
    }
  }
  return bestState;
}

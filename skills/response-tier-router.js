// Skill: response-tier-router
// Purpose: Route requests to an appropriate tier: static/rule-based, small model, or power model.

/**
 * Decide which tier should handle a request.
 * @param {object} input
 * @param {string} input.intent
 * @param {object} input.userState
 * @returns {{ tier: number, message: string, data?: object }}
 */
export async function routeResponse(input) {
  console.log('Routing response for intent', input.intent);
  // TODO: interpret userState and intent to avoid unnecessary LLM usage.
  if (input.userState?.cachedAnswer) {
    return { tier: 0, message: 'Returning cached answer', data: input.userState.cachedAnswer };
  }
  if (input.userState?.budget && input.userState.budget < 5000) {
    return { tier: 1, message: 'Applying rule-based low-budget answer' };
  }
  // Default to powerful model until rules are implemented.
  return { tier: 3, message: 'Powerful LLM required for this intent' };
}

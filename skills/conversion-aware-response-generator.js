// Skill: conversion-aware-response-generator
// Purpose: Inject conversion-focused prompts into LLM answers based on intent, friction, and lead score.

/**
 * Augment a response with conversion nudges.
 * @param {object} input
 * @param {string} input.originalResponse
 * @param {object} input.userState
 * @param {number} input.leadQualityScore
 * @returns {{ modifiedResponse: string }}
 */
export function generateConversionAwareResponse(input) {
  let modifiedResponse = input.originalResponse;
  if (input.leadQualityScore > 0.7) {
    modifiedResponse += '\n\nLooks like you are ready for a next step—should I help schedule a call or check availability for you?';
  } else if (input.userState?.frictionScore > 0.6) {
    modifiedResponse += '\n\nNeed anything simplified or a different angle?';
  } else {
    modifiedResponse += '\n\nLet me know if I can help you explore anything else.';
  }
  return { modifiedResponse };
}

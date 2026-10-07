/**
 * "Just signed up" hand-off: Sign up -> Company profile -> Payment details -> Dashboard.
 * A tiny browser-only flag (never sent anywhere); every step can be skipped.
 */
const KEY = 'collections.onboarding'
export type OnboardingState = 'start' | 'active' | null

export function getOnboarding(): OnboardingState {
  try {
    const v = window.localStorage.getItem(KEY)
    return v === 'start' || v === 'active' ? v : null
  } catch {
    return null
  }
}

export function setOnboarding(state: OnboardingState): void {
  try {
    if (state) window.localStorage.setItem(KEY, state)
    else window.localStorage.removeItem(KEY)
  } catch {
    /* private mode: onboarding simply does not show */
  }
}

export function startOnboarding(): void {
  setOnboarding('start')
}

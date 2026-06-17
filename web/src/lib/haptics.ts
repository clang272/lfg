import { WebHaptics, type HapticInput } from "web-haptics";

/**
 * Imperative haptic singleton for use in shared UI components.
 *
 * Silently no-ops on unsupported platforms (desktop browsers, SSR).
 * Use `useHaptics()` hook in page-level components instead.
 */
let instance: WebHaptics | null = null;

function getInstance(): WebHaptics {
  if (!instance) {
    instance = new WebHaptics();
  }
  return instance;
}

export function haptic(type?: HapticInput) {
  getInstance().trigger(type);
}

/**
 * Utility functions for calculating and working with deltas
 */

export interface Delta {
  arrived?: Array<{ id: string; name: string }>;
  departed?: Array<{ id: string; name: string }>;
  messages?: number;
  events?: Array<any>;
  locationChanged?: boolean;
}

/**
 * Check if a delta is empty (no changes)
 */
export function isDeltaEmpty(delta: Delta): boolean {
  return (
    (!delta.arrived || delta.arrived.length === 0) &&
    (!delta.departed || delta.departed.length === 0) &&
    (!delta.messages || delta.messages === 0) &&
    (!delta.events || delta.events.length === 0) &&
    !delta.locationChanged
  );
}

/**
 * Merge multiple deltas into one
 */
export function mergeDeltas(...deltas: Delta[]): Delta {
  const merged: Delta = {};

  for (const delta of deltas) {
    if (delta.arrived) {
      merged.arrived = [...(merged.arrived || []), ...delta.arrived];
    }
    if (delta.departed) {
      merged.departed = [...(merged.departed || []), ...delta.departed];
    }
    if (delta.messages) {
      merged.messages = (merged.messages || 0) + delta.messages;
    }
    if (delta.events) {
      merged.events = [...(merged.events || []), ...delta.events];
    }
    if (delta.locationChanged) {
      merged.locationChanged = true;
    }
  }

  return merged;
}

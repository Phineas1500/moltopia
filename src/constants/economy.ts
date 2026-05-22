export const STARTING_BALANCE_CENTS = 1000000; // $10,000
export const BASE_ELEMENT_PRICE_CENTS = 1000; // $10
export const SYSTEM_AGENT_ID = 'agent_system';

// Recovery work gives broke agents enough cash for one craft_elements action.
// It is funded from the World Treasury, so it recirculates prior system spend.
export const RECOVERY_WORK_TARGET_BALANCE_CENTS = BASE_ELEMENT_PRICE_CENTS * 2; // $20
export const RECOVERY_WORK_COOLDOWN_HOURS = 1;
export const RECOVERY_WORK_TASKS = [
  'market_research',
  'workshop_cleanup',
  'archive_cataloging',
  'exchange_errand',
] as const;

export type RecoveryWorkTask = typeof RECOVERY_WORK_TASKS[number];

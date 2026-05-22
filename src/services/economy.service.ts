import { db } from '../db/index.js';
import { accounts, transactions, items, inventory, trades, agents } from '../db/schema.js';
import { eq, and, or, sql, gt, desc } from 'drizzle-orm';
import {
  RECOVERY_WORK_COOLDOWN_HOURS,
  RECOVERY_WORK_TARGET_BALANCE_CENTS,
  RECOVERY_WORK_TASKS,
  STARTING_BALANCE_CENTS,
  SYSTEM_AGENT_ID,
  type RecoveryWorkTask,
} from '../constants/economy.js';
import { WorldDemandService } from './world-demand.service.js';
import { tryGetRedis } from './cache.service.js';

const DEFAULT_RECOVERY_WORK_TASK: RecoveryWorkTask = 'market_research';
const RECOVERY_WORK_TASK_LABELS: Record<RecoveryWorkTask, string> = {
  market_research: 'market research',
  workshop_cleanup: 'workshop cleanup',
  archive_cataloging: 'archive cataloging',
  exchange_errand: 'exchange errand',
};

function normalizeRecoveryWorkTask(task?: string): RecoveryWorkTask {
  return RECOVERY_WORK_TASKS.includes(task as RecoveryWorkTask)
    ? task as RecoveryWorkTask
    : DEFAULT_RECOVERY_WORK_TASK;
}

export const EconomyService = {
  // ============ ACCOUNTS ============

  /**
   * Create account for new agent
   */
  async createAccount(agentId: string) {
    const [account] = await db
      .insert(accounts)
      .values({
        agentId,
        balance: STARTING_BALANCE_CENTS,
      })
      .returning();

    // Log the initial credit
    await this.logTransaction({
      toAgentId: agentId,
      amount: STARTING_BALANCE_CENTS,
      type: 'reward',
      description: 'Welcome bonus - starting balance',
    });

    return account;
  },

  /**
   * Get agent's account
   */
  async getAccount(agentId: string) {
    const account = await db.query.accounts.findFirst({
      where: eq(accounts.agentId, agentId),
    });
    return account;
  },

  /**
   * Get balance in dollars (for display)
   */
  async getBalance(agentId: string): Promise<number> {
    const account = await this.getAccount(agentId);
    return account ? account.balance / 100 : 0;
  },

  /**
   * Get balance in cents (for calculations)
   */
  async getBalanceCents(agentId: string): Promise<number> {
    const account = await this.getAccount(agentId);
    return account?.balance || 0;
  },

  // ============ TRANSFERS ============

  /**
   * Transfer money between agents
   */
  async transfer(fromAgentId: string, toAgentId: string, amountCents: number, description?: string) {
    if (amountCents <= 0) {
      throw new Error('Amount must be positive');
    }

    // Check sender's balance
    const fromAccount = await this.getAccount(fromAgentId);
    if (!fromAccount || fromAccount.balance < amountCents) {
      throw new Error('Insufficient funds');
    }

    // Deduct from sender
    await db
      .update(accounts)
      .set({
        balance: sql`${accounts.balance} - ${amountCents}`,
        updatedAt: new Date(),
      })
      .where(eq(accounts.agentId, fromAgentId));

    // Add to recipient
    await db
      .update(accounts)
      .set({
        balance: sql`${accounts.balance} + ${amountCents}`,
        updatedAt: new Date(),
      })
      .where(eq(accounts.agentId, toAgentId));

    // Log transaction
    const txn = await this.logTransaction({
      fromAgentId,
      toAgentId,
      amount: amountCents,
      type: 'transfer',
      description: description || 'Money transfer',
    });

    return txn;
  },

  // ============ TRANSACTIONS ============

  /**
   * Log a transaction
   */
  async logTransaction(data: {
    fromAgentId?: string;
    toAgentId?: string;
    amount: number;
    type: string;
    description?: string;
    referenceId?: string;
    referenceType?: string;
  }) {
    const id = `txn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const [txn] = await db
      .insert(transactions)
      .values({
        id,
        fromAgentId: data.fromAgentId || null,
        toAgentId: data.toAgentId || null,
        amount: data.amount,
        type: data.type,
        description: data.description,
        referenceId: data.referenceId,
        referenceType: data.referenceType,
      })
      .returning();

    return txn;
  },

  /**
   * Ensure the system treasury account exists.
   */
  async ensureSystemAccount() {
    await db.insert(agents).values({
      id: SYSTEM_AGENT_ID,
      name: 'World Treasury',
      ownerHandle: '@moltopia',
      description: 'System account that recirculates money spent on world-supplied goods.',
      avatarEmoji: '🏛️',
      authToken: 'system_treasury_no_login',
      homeLocationId: 'loc_exchange',
      status: 'active',
      verified: true,
      verifiedAt: new Date(),
      claimedByTwitter: 'moltopia',
    }).onConflictDoUpdate({
      target: agents.id,
      set: {
        name: 'World Treasury',
        ownerHandle: '@moltopia',
        description: 'System account that recirculates money spent on world-supplied goods.',
        avatarEmoji: '🏛️',
        status: 'active',
        homeLocationId: 'loc_exchange',
        verified: true,
        verifiedAt: new Date(),
        claimedByTwitter: 'moltopia',
      },
    });

    await db.insert(accounts).values({
      agentId: SYSTEM_AGENT_ID,
      balance: 0,
    }).onConflictDoNothing();
  },

  /**
   * Credit money spent on system-supplied goods into the world treasury.
   */
  async creditSystemTreasury(data: {
    fromAgentId: string;
    amount: number;
    description: string;
    referenceId?: string;
    referenceType?: string;
  }) {
    if (data.amount <= 0) return;

    await this.ensureSystemAccount();

    await db
      .update(accounts)
      .set({
        balance: sql`${accounts.balance} + ${data.amount}`,
        updatedAt: new Date(),
      })
      .where(eq(accounts.agentId, SYSTEM_AGENT_ID));

    await this.logTransaction({
      fromAgentId: data.fromAgentId,
      toAgentId: SYSTEM_AGENT_ID,
      amount: data.amount,
      type: 'purchase',
      description: data.description,
      referenceId: data.referenceId,
      referenceType: data.referenceType,
    });

    try {
      await WorldDemandService.runOnce({ reason: 'treasury_credit', maxOrders: 2 });
    } catch (error) {
      console.error('World demand run failed after treasury credit:', error);
    }
  },

  /**
   * Get the current unreserved system treasury balance.
   */
  async getSystemTreasuryBalanceCents(): Promise<number> {
    await this.ensureSystemAccount();

    const account = await db.query.accounts.findFirst({
      where: eq(accounts.agentId, SYSTEM_AGENT_ID),
    });

    return account?.balance ?? 0;
  },

  /**
   * Treasury-funded recovery work for agents who are too broke to craft.
   * This is not a new-money faucet: every payout is debited from the World
   * Treasury, which is funded by prior purchases from system supply.
   */
  async claimWorldWork(agentId: string, task?: string) {
    const selectedTask = normalizeRecoveryWorkTask(task);
    const taskLabel = RECOVERY_WORK_TASK_LABELS[selectedTask];
    const cooldownMs = RECOVERY_WORK_COOLDOWN_HOURS * 60 * 60 * 1000;
    const cooldownCutoff = new Date(Date.now() - cooldownMs);
    const now = new Date();
    const lockKey = `world_work_lock:${agentId}`;
    const lockToken = `${now.getTime()}_${Math.random().toString(36).slice(2, 10)}`;
    const redis = await tryGetRedis('world work lock');
    let lockAcquired = false;

    if (redis) {
      const lockResult = await redis.set(lockKey, lockToken, { NX: true, EX: 60 });
      if (lockResult !== 'OK') {
        throw new Error('World work claim already in progress. Try again in a minute.');
      }
      lockAcquired = true;
    }

    try {
      await this.ensureSystemAccount();

      return await db.transaction(async (tx) => {
        await tx.insert(accounts).values({
          agentId,
          balance: 0,
        }).onConflictDoNothing();

        const [account] = await tx
          .select({ balance: accounts.balance })
          .from(accounts)
          .where(eq(accounts.agentId, agentId))
          .limit(1);

        if (!account) {
          throw new Error('Account not found');
        }

        if (account.balance >= RECOVERY_WORK_TARGET_BALANCE_CENTS) {
          throw new Error(
            `World work is for agents below $${(RECOVERY_WORK_TARGET_BALANCE_CENTS / 100).toFixed(2)}. Your balance is $${(account.balance / 100).toFixed(2)}.`,
          );
        }

        const [recentClaim] = await tx
          .select({ createdAt: transactions.createdAt })
          .from(transactions)
          .where(and(
            eq(transactions.fromAgentId, SYSTEM_AGENT_ID),
            eq(transactions.toAgentId, agentId),
            eq(transactions.referenceType, 'world_work'),
            gt(transactions.createdAt, cooldownCutoff),
          ))
          .orderBy(desc(transactions.createdAt))
          .limit(1);

        if (recentClaim) {
          const nextAvailableAt = new Date(recentClaim.createdAt.getTime() + cooldownMs);
          throw new Error(`World work is on cooldown until ${nextAvailableAt.toISOString()}.`);
        }

        const payout = RECOVERY_WORK_TARGET_BALANCE_CENTS - account.balance;
        const [treasuryDebit] = await tx
          .update(accounts)
          .set({
            balance: sql`${accounts.balance} - ${payout}`,
            updatedAt: now,
          })
          .where(and(
            eq(accounts.agentId, SYSTEM_AGENT_ID),
            sql`${accounts.balance} >= ${payout}`,
          ))
          .returning({ balance: accounts.balance });

        if (!treasuryDebit) {
          throw new Error('World Treasury does not have enough funds for recovery work right now.');
        }

        const [updatedAccount] = await tx
          .update(accounts)
          .set({
            balance: sql`${accounts.balance} + ${payout}`,
            updatedAt: now,
          })
          .where(eq(accounts.agentId, agentId))
          .returning({ balance: accounts.balance });

        const transactionId = `txn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const [transaction] = await tx
          .insert(transactions)
          .values({
            id: transactionId,
            fromAgentId: SYSTEM_AGENT_ID,
            toAgentId: agentId,
            amount: payout,
            type: 'reward',
            description: `World Treasury ${taskLabel} commission`,
            referenceId: selectedTask,
            referenceType: 'world_work',
          })
          .returning();

        return {
          task: selectedTask,
          taskLabel,
          payoutCents: payout,
          payoutDollars: payout / 100,
          balanceCents: updatedAccount.balance,
          balanceDollars: updatedAccount.balance / 100,
          treasuryBalanceCents: treasuryDebit.balance,
          treasuryBalanceDollars: treasuryDebit.balance / 100,
          cooldownHours: RECOVERY_WORK_COOLDOWN_HOURS,
          transaction,
          message: `Completed ${taskLabel}. The World Treasury paid $${(payout / 100).toFixed(2)}, enough to get back to one craft attempt.`,
        };
      });
    } finally {
      if (redis && lockAcquired) {
        try {
          const currentLock = await redis.get(lockKey);
          if (currentLock === lockToken) {
            await redis.del(lockKey);
          }
        } catch {
          // Lock cleanup is best-effort; the key expires quickly.
        }
      }
    }
  },

  /**
   * Get agent's transaction history
   */
  async getTransactionHistory(agentId: string, limit: number = 20) {
    return db.query.transactions.findMany({
      where: or(
        eq(transactions.fromAgentId, agentId),
        eq(transactions.toAgentId, agentId)
      ),
      orderBy: (t, { desc }) => [desc(t.createdAt)],
      limit,
    });
  },

  // ============ ITEMS ============

  /**
   * Get all items in the catalog
   */
  async getItemCatalog(category?: string) {
    if (category) {
      return db.query.items.findMany({
        where: eq(items.category, category),
      });
    }
    return db.query.items.findMany();
  },

  /**
   * Get a specific item
   */
  async getItem(itemId: string) {
    return db.query.items.findFirst({
      where: eq(items.id, itemId),
    });
  },

  /**
   * Purchase an item
   */
  async purchaseItem(agentId: string, itemId: string, quantity: number = 1) {
    const item = await this.getItem(itemId);
    if (!item) {
      throw new Error('Item not found');
    }

    const totalCost = item.basePrice * quantity;

    // Check balance
    const account = await this.getAccount(agentId);
    if (!account || account.balance < totalCost) {
      throw new Error('Insufficient funds');
    }

    // Check supply if limited
    if (item.limited && item.maxSupply) {
      if (item.currentSupply + quantity > item.maxSupply) {
        throw new Error('Not enough supply available');
      }
    }

    await this.ensureSystemAccount();

    // Deduct money
    await db
      .update(accounts)
      .set({
        balance: sql`${accounts.balance} - ${totalCost}`,
        updatedAt: new Date(),
      })
      .where(eq(accounts.agentId, agentId));

    // Update item supply
    await db
      .update(items)
      .set({
        currentSupply: sql`${items.currentSupply} + ${quantity}`,
      })
      .where(eq(items.id, itemId));

    // Add to inventory (or update quantity if already owned)
    const existingInventory = await db.query.inventory.findFirst({
      where: and(
        eq(inventory.agentId, agentId),
        eq(inventory.itemId, itemId)
      ),
    });

    if (existingInventory) {
      await db
        .update(inventory)
        .set({
          quantity: sql`${inventory.quantity} + ${quantity}`,
        })
        .where(eq(inventory.id, existingInventory.id));
    } else {
      const invId = `inv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      await db.insert(inventory).values({
        id: invId,
        agentId,
        itemId,
        quantity,
        acquiredPrice: item.basePrice,
      });
    }

    // Recirculate the system purchase into the world treasury.
    await this.creditSystemTreasury({
      fromAgentId: agentId,
      amount: totalCost,
      description: `Purchased ${quantity}x ${item.name}`,
      referenceId: itemId,
      referenceType: 'item',
    });

    return { item, quantity, totalCost };
  },

  // ============ INVENTORY ============

  /**
   * Get agent's inventory
   */
  async getInventory(agentId: string) {
    return db.query.inventory.findMany({
      where: eq(inventory.agentId, agentId),
      with: {
        item: true,
      },
    });
  },

  /**
   * Check if agent has item
   */
  async hasItem(agentId: string, itemId: string, quantity: number = 1): Promise<boolean> {
    const inv = await db.query.inventory.findFirst({
      where: and(
        eq(inventory.agentId, agentId),
        eq(inventory.itemId, itemId)
      ),
    });
    return inv ? inv.quantity >= quantity : false;
  },

  // ============ TRADING ============

  /**
   * Create a trade offer
   */
  async createTrade(data: {
    fromAgentId: string;
    toAgentId: string;
    offerItems?: { itemId: string; quantity: number }[];
    offerAmount?: number;
    requestItems?: { itemId: string; quantity: number }[];
    requestAmount?: number;
    message?: string;
    expiresInHours?: number;
  }) {
    const id = `trade_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Validate the initiator has what they're offering
    if (data.offerAmount && data.offerAmount > 0) {
      const balance = await this.getBalanceCents(data.fromAgentId);
      if (balance < data.offerAmount) {
        throw new Error('Insufficient funds for trade offer');
      }
    }

    if (data.offerItems) {
      for (const item of data.offerItems) {
        const hasIt = await this.hasItem(data.fromAgentId, item.itemId, item.quantity);
        if (!hasIt) {
          throw new Error(`You don't have enough of item ${item.itemId}`);
        }
      }
    }

    const expiresAt = data.expiresInHours
      ? new Date(Date.now() + data.expiresInHours * 60 * 60 * 1000)
      : new Date(Date.now() + 24 * 60 * 60 * 1000); // Default 24 hours

    const [trade] = await db
      .insert(trades)
      .values({
        id,
        fromAgentId: data.fromAgentId,
        toAgentId: data.toAgentId,
        offerItems: data.offerItems || [],
        offerAmount: data.offerAmount || 0,
        requestItems: data.requestItems || [],
        requestAmount: data.requestAmount || 0,
        message: data.message,
        expiresAt,
        status: 'pending',
      })
      .returning();

    return trade;
  },

  /**
   * Accept a trade
   */
  async acceptTrade(tradeId: string, agentId: string) {
    const trade = await db.query.trades.findFirst({
      where: eq(trades.id, tradeId),
    });

    if (!trade) {
      throw new Error('Trade not found');
    }

    if (trade.toAgentId !== agentId) {
      throw new Error('This trade is not for you');
    }

    if (trade.status !== 'pending') {
      throw new Error(`Trade is already ${trade.status}`);
    }

    if (trade.expiresAt && new Date() > trade.expiresAt) {
      await db.update(trades).set({ status: 'expired' }).where(eq(trades.id, tradeId));
      throw new Error('Trade has expired');
    }

    // Validate acceptor has what's requested
    if (trade.requestAmount > 0) {
      const balance = await this.getBalanceCents(agentId);
      if (balance < trade.requestAmount) {
        throw new Error('Insufficient funds to accept trade');
      }
    }

    const requestItems = trade.requestItems as { itemId: string; quantity: number }[];
    for (const item of requestItems) {
      const hasIt = await this.hasItem(agentId, item.itemId, item.quantity);
      if (!hasIt) {
        throw new Error(`You don't have enough of item ${item.itemId}`);
      }
    }

    // Execute the trade
    // Transfer money
    if (trade.offerAmount > 0) {
      await this.transferInternal(trade.fromAgentId, trade.toAgentId, trade.offerAmount);
    }
    if (trade.requestAmount > 0) {
      await this.transferInternal(trade.toAgentId, trade.fromAgentId, trade.requestAmount);
    }

    // Transfer items
    const offerItems = trade.offerItems as { itemId: string; quantity: number }[];
    for (const item of offerItems) {
      await this.transferItem(trade.fromAgentId, trade.toAgentId, item.itemId, item.quantity);
    }
    for (const item of requestItems) {
      await this.transferItem(trade.toAgentId, trade.fromAgentId, item.itemId, item.quantity);
    }

    // Mark trade as accepted
    await db
      .update(trades)
      .set({
        status: 'accepted',
        resolvedAt: new Date(),
      })
      .where(eq(trades.id, tradeId));

    // Log transaction
    await this.logTransaction({
      fromAgentId: trade.fromAgentId,
      toAgentId: trade.toAgentId,
      amount: trade.offerAmount + trade.requestAmount,
      type: 'trade',
      description: 'Trade completed',
      referenceId: tradeId,
      referenceType: 'trade',
    });

    return { success: true, tradeId };
  },

  /**
   * Reject a trade
   */
  async rejectTrade(tradeId: string, agentId: string) {
    const trade = await db.query.trades.findFirst({
      where: eq(trades.id, tradeId),
    });

    if (!trade) {
      throw new Error('Trade not found');
    }

    if (trade.toAgentId !== agentId) {
      throw new Error('This trade is not for you');
    }

    if (trade.status !== 'pending') {
      throw new Error(`Trade is already ${trade.status}`);
    }

    await db
      .update(trades)
      .set({
        status: 'rejected',
        resolvedAt: new Date(),
      })
      .where(eq(trades.id, tradeId));

    return { success: true };
  },

  /**
   * Cancel a trade (by initiator)
   */
  async cancelTrade(tradeId: string, agentId: string) {
    const trade = await db.query.trades.findFirst({
      where: eq(trades.id, tradeId),
    });

    if (!trade) {
      throw new Error('Trade not found');
    }

    if (trade.fromAgentId !== agentId) {
      throw new Error('Only the trade initiator can cancel');
    }

    if (trade.status !== 'pending') {
      throw new Error(`Trade is already ${trade.status}`);
    }

    await db
      .update(trades)
      .set({
        status: 'cancelled',
        resolvedAt: new Date(),
      })
      .where(eq(trades.id, tradeId));

    return { success: true };
  },

  /**
   * Get pending trades for an agent
   */
  async getPendingTrades(agentId: string) {
    return db.query.trades.findMany({
      where: and(
        or(
          eq(trades.fromAgentId, agentId),
          eq(trades.toAgentId, agentId)
        ),
        eq(trades.status, 'pending')
      ),
      orderBy: (t, { desc }) => [desc(t.createdAt)],
    });
  },

  // ============ INTERNAL HELPERS ============

  /**
   * Internal transfer (no validation, used during trade execution)
   */
  async transferInternal(fromAgentId: string, toAgentId: string, amountCents: number) {
    await db
      .update(accounts)
      .set({
        balance: sql`${accounts.balance} - ${amountCents}`,
        updatedAt: new Date(),
      })
      .where(eq(accounts.agentId, fromAgentId));

    await db
      .update(accounts)
      .set({
        balance: sql`${accounts.balance} + ${amountCents}`,
        updatedAt: new Date(),
      })
      .where(eq(accounts.agentId, toAgentId));
  },

  /**
   * Transfer item between agents
   */
  async transferItem(fromAgentId: string, toAgentId: string, itemId: string, quantity: number) {
    // Remove from sender
    const fromInv = await db.query.inventory.findFirst({
      where: and(
        eq(inventory.agentId, fromAgentId),
        eq(inventory.itemId, itemId)
      ),
    });

    if (!fromInv || fromInv.quantity < quantity) {
      throw new Error('Not enough items to transfer');
    }

    if (fromInv.quantity === quantity) {
      await db.delete(inventory).where(eq(inventory.id, fromInv.id));
    } else {
      await db
        .update(inventory)
        .set({ quantity: sql`${inventory.quantity} - ${quantity}` })
        .where(eq(inventory.id, fromInv.id));
    }

    // Add to recipient
    const toInv = await db.query.inventory.findFirst({
      where: and(
        eq(inventory.agentId, toAgentId),
        eq(inventory.itemId, itemId)
      ),
    });

    if (toInv) {
      await db
        .update(inventory)
        .set({ quantity: sql`${inventory.quantity} + ${quantity}` })
        .where(eq(inventory.id, toInv.id));
    } else {
      const invId = `inv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      await db.insert(inventory).values({
        id: invId,
        agentId: toAgentId,
        itemId,
        quantity,
      });
    }
  },
};

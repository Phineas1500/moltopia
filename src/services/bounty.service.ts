import { db } from '../db/index.js';
import { bounties, items, inventory, accounts, agents, transactions } from '../db/schema.js';
import { eq, and, sql, desc, lt } from 'drizzle-orm';
import { EconomyService } from './economy.service.js';

export const BountyService = {
  /**
   * Post a new bounty — escrow funds from creator
   */
  async postBounty(data: {
    creatorId: string;
    itemId: string;
    rewardDollars: number;
    quantity?: number;
    message?: string;
    expiresInHours?: number;
  }) {
    const { creatorId, itemId, rewardDollars, quantity = 1, message, expiresInHours = 72 } = data;

    if (rewardDollars <= 0) throw new Error('Reward must be positive');
    if (quantity <= 0) throw new Error('Quantity must be positive');

    // Verify item exists and is not a base element
    const item = await db.query.items.findFirst({
      where: eq(items.id, itemId),
    });
    if (!item) throw new Error('Item not found');
    if (item.category === 'base_element') {
      throw new Error('Cannot post bounties for base elements. Buy them from the system: POST /crafting/elements/purchase ($10 each)');
    }

    const rewardCents = Math.round(rewardDollars * 100);

    // Check creator has funds
    const account = await db.query.accounts.findFirst({
      where: eq(accounts.agentId, creatorId),
    });
    if (!account || account.balance < rewardCents) {
      throw new Error(`Insufficient funds. You have $${(account?.balance || 0) / 100}, need $${rewardDollars}`);
    }

    // Escrow funds
    await db
      .update(accounts)
      .set({
        balance: sql`${accounts.balance} - ${rewardCents}`,
        updatedAt: new Date(),
      })
      .where(eq(accounts.agentId, creatorId));

    const bountyId = `bounty_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000);

    // Insert bounty
    const [bounty] = await db.insert(bounties).values({
      id: bountyId,
      creatorId,
      itemId,
      reward: rewardCents,
      quantity,
      status: 'open',
      message: message || null,
      expiresAt,
    }).returning();

    // Log escrow transaction
    await EconomyService.logTransaction({
      fromAgentId: creatorId,
      amount: rewardCents,
      type: 'bounty_escrow',
      description: `Bounty posted for ${quantity}x ${item.name}`,
      referenceId: bountyId,
      referenceType: 'bounty',
    });

    return bounty;
  },

  /**
   * Fulfill a bounty — transfer item and pay reward
   */
  async fulfillBounty(bountyId: string, agentId: string) {
    // Expire old bounties first
    await this.expireOldBounties();

    const bounty = await db.query.bounties.findFirst({
      where: eq(bounties.id, bountyId),
    });
    if (!bounty) throw new Error('Bounty not found');
    if (bounty.status !== 'open') throw new Error(`Bounty is ${bounty.status}, not open`);
    if (new Date() > bounty.expiresAt) throw new Error('Bounty has expired');
    if (bounty.creatorId === agentId) throw new Error('Cannot fulfill your own bounty');

    // Verify fulfiller has the item
    const inv = await db.query.inventory.findFirst({
      where: and(
        eq(inventory.agentId, agentId),
        eq(inventory.itemId, bounty.itemId)
      ),
    });
    if (!inv || inv.quantity < bounty.quantity) {
      throw new Error(`Insufficient inventory. You have ${inv?.quantity || 0}, need ${bounty.quantity}`);
    }

    // Deduct item from fulfiller
    if (inv.quantity === bounty.quantity) {
      await db.delete(inventory).where(eq(inventory.id, inv.id));
    } else {
      await db
        .update(inventory)
        .set({ quantity: sql`${inventory.quantity} - ${bounty.quantity}` })
        .where(eq(inventory.id, inv.id));
    }

    // Add item to creator
    const creatorInv = await db.query.inventory.findFirst({
      where: and(
        eq(inventory.agentId, bounty.creatorId),
        eq(inventory.itemId, bounty.itemId)
      ),
    });

    if (creatorInv) {
      await db
        .update(inventory)
        .set({ quantity: sql`${inventory.quantity} + ${bounty.quantity}` })
        .where(eq(inventory.id, creatorInv.id));
    } else {
      const invId = `inv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      await db.insert(inventory).values({
        id: invId,
        agentId: bounty.creatorId,
        itemId: bounty.itemId,
        quantity: bounty.quantity,
      });
    }

    // Credit reward to fulfiller (from escrow)
    await db
      .update(accounts)
      .set({
        balance: sql`${accounts.balance} + ${bounty.reward}`,
        updatedAt: new Date(),
      })
      .where(eq(accounts.agentId, agentId));

    // Update bounty status
    await db
      .update(bounties)
      .set({
        status: 'fulfilled',
        fulfilledBy: agentId,
        fulfilledAt: new Date(),
      })
      .where(eq(bounties.id, bountyId));

    // Log reward transaction
    const item = await db.query.items.findFirst({ where: eq(items.id, bounty.itemId) });
    await EconomyService.logTransaction({
      fromAgentId: bounty.creatorId,
      toAgentId: agentId,
      amount: bounty.reward,
      type: 'bounty_reward',
      description: `Bounty fulfilled: ${bounty.quantity}x ${item?.name || bounty.itemId}`,
      referenceId: bountyId,
      referenceType: 'bounty',
    });

    // Award +2 reputation to fulfiller
    await db
      .update(agents)
      .set({ reputation: sql`${agents.reputation} + 2` })
      .where(eq(agents.id, agentId));

    return {
      ...bounty,
      status: 'fulfilled',
      fulfilledBy: agentId,
      fulfilledAt: new Date(),
    };
  },

  /**
   * Cancel a bounty — refund escrowed funds
   */
  async cancelBounty(bountyId: string, agentId: string) {
    const bounty = await db.query.bounties.findFirst({
      where: eq(bounties.id, bountyId),
    });
    if (!bounty) throw new Error('Bounty not found');
    if (bounty.creatorId !== agentId) throw new Error('Only the creator can cancel a bounty');
    if (bounty.status !== 'open') throw new Error(`Bounty is ${bounty.status}, cannot cancel`);

    // Refund escrowed amount
    await db
      .update(accounts)
      .set({
        balance: sql`${accounts.balance} + ${bounty.reward}`,
        updatedAt: new Date(),
      })
      .where(eq(accounts.agentId, agentId));

    // Update status
    await db
      .update(bounties)
      .set({ status: 'cancelled' })
      .where(eq(bounties.id, bountyId));

    // Log refund
    await EconomyService.logTransaction({
      toAgentId: agentId,
      amount: bounty.reward,
      type: 'bounty_refund',
      description: 'Bounty cancelled — funds refunded',
      referenceId: bountyId,
      referenceType: 'bounty',
    });

    return { success: true };
  },

  /**
   * Get open bounties with creator/item info
   */
  async getOpenBounties() {
    // Expire old bounties first
    await this.expireOldBounties();

    return db.query.bounties.findMany({
      where: eq(bounties.status, 'open'),
      with: {
        creator: {
          columns: { id: true, name: true, avatarEmoji: true },
        },
        item: {
          columns: { id: true, name: true, emoji: true, category: true },
        },
      },
      orderBy: [desc(bounties.createdAt)],
    });
  },

  /**
   * Get a single bounty by ID
   */
  async getBounty(bountyId: string) {
    return db.query.bounties.findFirst({
      where: eq(bounties.id, bountyId),
      with: {
        creator: {
          columns: { id: true, name: true, avatarEmoji: true },
        },
        item: {
          columns: { id: true, name: true, emoji: true, category: true },
        },
      },
    });
  },

  /**
   * Get all bounties (for frontend — includes fulfilled/expired)
   */
  async getAllBounties(limit: number = 50) {
    return db.query.bounties.findMany({
      with: {
        creator: {
          columns: { id: true, name: true, avatarEmoji: true },
        },
        item: {
          columns: { id: true, name: true, emoji: true, category: true },
        },
      },
      orderBy: [desc(bounties.createdAt)],
      limit,
    });
  },

  /**
   * Expire old bounties and refund escrowed funds
   */
  async expireOldBounties() {
    const expiredBounties = await db.query.bounties.findMany({
      where: and(
        eq(bounties.status, 'open'),
        lt(bounties.expiresAt, new Date())
      ),
    });

    for (const bounty of expiredBounties) {
      // Refund escrowed amount
      await db
        .update(accounts)
        .set({
          balance: sql`${accounts.balance} + ${bounty.reward}`,
          updatedAt: new Date(),
        })
        .where(eq(accounts.agentId, bounty.creatorId));

      // Mark expired
      await db
        .update(bounties)
        .set({ status: 'expired' })
        .where(eq(bounties.id, bounty.id));

      // Log refund
      await EconomyService.logTransaction({
        toAgentId: bounty.creatorId,
        amount: bounty.reward,
        type: 'bounty_refund',
        description: 'Bounty expired — funds refunded',
        referenceId: bounty.id,
        referenceType: 'bounty',
      });
    }

    return expiredBounties.length;
  },
};

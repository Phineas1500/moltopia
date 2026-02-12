import { db } from '../db/index.js';
import { bounties, bountyProposals, items, inventory, accounts, agents, marketOrders } from '../db/schema.js';
import { eq, and, sql, desc, lt, ne } from 'drizzle-orm';
import { EconomyService } from './economy.service.js';

export const BountyService = {
  /**
   * Get circulating supply of an item (inventory + open sell orders)
   */
  async getCirculatingSupply(itemId: string): Promise<number> {
    const [invResult] = await db
      .select({ total: sql<number>`COALESCE(SUM(${inventory.quantity}), 0)::int` })
      .from(inventory)
      .where(eq(inventory.itemId, itemId));

    const [sellResult] = await db
      .select({ total: sql<number>`COALESCE(SUM(${marketOrders.quantity} - ${marketOrders.filledQuantity}), 0)::int` })
      .from(marketOrders)
      .where(and(
        eq(marketOrders.itemId, itemId),
        eq(marketOrders.orderType, 'sell'),
        eq(marketOrders.status, 'open')
      ));

    return (invResult?.total ?? 0) + (sellResult?.total ?? 0);
  },

  /**
   * Post a new bounty — escrow funds from creator
   */
  async postBounty(data: {
    creatorId: string;
    bountyType?: 'item' | 'freetext';
    itemId?: string;
    description?: string;
    rewardDollars: number;
    quantity?: number;
    message?: string;
    expiresInHours?: number;
  }) {
    const { creatorId, bountyType = 'item', itemId, description, rewardDollars, quantity = 1, message, expiresInHours = 72 } = data;

    if (rewardDollars <= 0) throw new Error('Reward must be positive');
    if (quantity <= 0) throw new Error('Quantity must be positive');

    let itemName = 'free-text request';

    if (bountyType === 'item') {
      if (!itemId) throw new Error('itemId is required for item bounties');

      // Verify item exists and is not a base element
      const item = await db.query.items.findFirst({
        where: eq(items.id, itemId),
      });
      if (!item) throw new Error('Item not found');
      if (item.category === 'base_element') {
        throw new Error('Cannot post bounties for base elements. Buy them from the system: POST /crafting/elements/purchase ($10 each)');
      }

      // Supply-0 check: item bounties only allowed when zero copies in circulation
      const circulating = await this.getCirculatingSupply(itemId);
      if (circulating > 0) {
        throw new Error(`This item has ${circulating} copies in circulation. Use market_buy to purchase it instead, or post a free-text bounty (bountyType: "freetext") to describe what you want.`);
      }

      itemName = item.name;
    } else if (bountyType === 'freetext') {
      if (!description || description.trim().length === 0) {
        throw new Error('description is required for free-text bounties (1-500 characters)');
      }
      if (description.length > 500) {
        throw new Error('description must be 500 characters or less');
      }
      if (itemId) {
        throw new Error('itemId should not be provided for free-text bounties');
      }
    } else {
      throw new Error('bountyType must be "item" or "freetext"');
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
      bountyType,
      itemId: bountyType === 'item' ? itemId! : null,
      description: bountyType === 'freetext' ? description!.trim() : null,
      reward: rewardCents,
      quantity,
      status: 'open',
      message: message || null,
      expiresAt,
    }).returning();

    // Log escrow transaction
    const txDesc = bountyType === 'freetext'
      ? `Free-text bounty posted: "${description!.substring(0, 50)}${description!.length > 50 ? '...' : ''}"`
      : `Bounty posted for ${quantity}x ${itemName}`;

    await EconomyService.logTransaction({
      fromAgentId: creatorId,
      amount: rewardCents,
      type: 'bounty_escrow',
      description: txDesc,
      referenceId: bountyId,
      referenceType: 'bounty',
    });

    return bounty;
  },

  /**
   * Fulfill a bounty — transfer item and pay reward (item bounties only)
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

    // Guard: free-text bounties require proposals
    if (bounty.bountyType === 'freetext') {
      throw new Error('Free-text bounties require proposals. Use propose_bounty to propose an item, then the bounty creator will accept or reject it.');
    }

    if (!bounty.itemId) throw new Error('Bounty has no item specified');

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
   * Propose an item for a free-text bounty
   */
  async proposeBounty(data: {
    bountyId: string;
    proposerId: string;
    itemId: string;
    quantity?: number;
    message?: string;
  }) {
    const { bountyId, proposerId, itemId, quantity = 1, message } = data;

    // Validate bounty exists and is open
    const bounty = await db.query.bounties.findFirst({
      where: eq(bounties.id, bountyId),
    });
    if (!bounty) throw new Error('Bounty not found');
    if (bounty.status !== 'open') throw new Error(`Bounty is ${bounty.status}, not open`);
    if (new Date() > bounty.expiresAt) throw new Error('Bounty has expired');
    if (bounty.bountyType !== 'freetext') {
      throw new Error('Only free-text bounties accept proposals. For item bounties, use fulfill_bounty directly.');
    }
    if (bounty.creatorId === proposerId) {
      throw new Error('Cannot propose on your own bounty');
    }

    // Verify proposer has the item
    const inv = await db.query.inventory.findFirst({
      where: and(
        eq(inventory.agentId, proposerId),
        eq(inventory.itemId, itemId)
      ),
    });
    if (!inv || inv.quantity < quantity) {
      throw new Error(`Insufficient inventory. You have ${inv?.quantity || 0} of this item, need ${quantity}`);
    }

    // Check for duplicate pending proposal
    const existing = await db.query.bountyProposals.findFirst({
      where: and(
        eq(bountyProposals.bountyId, bountyId),
        eq(bountyProposals.proposerId, proposerId),
        eq(bountyProposals.status, 'pending')
      ),
    });
    if (existing) {
      throw new Error('You already have a pending proposal on this bounty. Wait for the creator to respond or withdraw it first.');
    }

    const proposalId = `proposal_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

    const [proposal] = await db.insert(bountyProposals).values({
      id: proposalId,
      bountyId,
      proposerId,
      itemId,
      quantity,
      message: message || null,
      status: 'pending',
      expiresAt,
    }).returning();

    return proposal;
  },

  /**
   * Accept a proposal — transfer item and pay reward
   */
  async acceptProposal(proposalId: string, agentId: string) {
    const proposal = await db.query.bountyProposals.findFirst({
      where: eq(bountyProposals.id, proposalId),
      with: { bounty: true, item: true },
    });
    if (!proposal) throw new Error('Proposal not found');
    if (proposal.status !== 'pending') throw new Error(`Proposal is ${proposal.status}, not pending`);
    if (proposal.bounty.creatorId !== agentId) throw new Error('Only the bounty creator can accept proposals');
    if (proposal.bounty.status !== 'open') throw new Error(`Bounty is ${proposal.bounty.status}, not open`);

    // Re-validate proposer still has the item
    const inv = await db.query.inventory.findFirst({
      where: and(
        eq(inventory.agentId, proposal.proposerId),
        eq(inventory.itemId, proposal.itemId)
      ),
    });
    if (!inv || inv.quantity < proposal.quantity) {
      throw new Error(`Proposer no longer has enough of this item (has ${inv?.quantity || 0}, need ${proposal.quantity}). They may have traded it away.`);
    }

    // Transfer item: proposer -> creator
    if (inv.quantity === proposal.quantity) {
      await db.delete(inventory).where(eq(inventory.id, inv.id));
    } else {
      await db
        .update(inventory)
        .set({ quantity: sql`${inventory.quantity} - ${proposal.quantity}` })
        .where(eq(inventory.id, inv.id));
    }

    const creatorInv = await db.query.inventory.findFirst({
      where: and(
        eq(inventory.agentId, agentId),
        eq(inventory.itemId, proposal.itemId)
      ),
    });
    if (creatorInv) {
      await db
        .update(inventory)
        .set({ quantity: sql`${inventory.quantity} + ${proposal.quantity}` })
        .where(eq(inventory.id, creatorInv.id));
    } else {
      const invId = `inv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      await db.insert(inventory).values({
        id: invId,
        agentId,
        itemId: proposal.itemId,
        quantity: proposal.quantity,
      });
    }

    // Credit reward to proposer from escrow
    await db
      .update(accounts)
      .set({
        balance: sql`${accounts.balance} + ${proposal.bounty.reward}`,
        updatedAt: new Date(),
      })
      .where(eq(accounts.agentId, proposal.proposerId));

    // Mark proposal accepted
    await db
      .update(bountyProposals)
      .set({ status: 'accepted', resolvedAt: new Date() })
      .where(eq(bountyProposals.id, proposalId));

    // Mark bounty fulfilled
    await db
      .update(bounties)
      .set({
        status: 'fulfilled',
        fulfilledBy: proposal.proposerId,
        fulfilledAt: new Date(),
      })
      .where(eq(bounties.id, proposal.bountyId));

    // Auto-reject all other pending proposals on this bounty
    await db
      .update(bountyProposals)
      .set({ status: 'rejected', resolvedAt: new Date() })
      .where(and(
        eq(bountyProposals.bountyId, proposal.bountyId),
        eq(bountyProposals.status, 'pending'),
        ne(bountyProposals.id, proposalId)
      ));

    // Log reward transaction
    await EconomyService.logTransaction({
      fromAgentId: agentId,
      toAgentId: proposal.proposerId,
      amount: proposal.bounty.reward,
      type: 'bounty_reward',
      description: `Bounty proposal accepted: ${proposal.quantity}x ${proposal.item?.name || proposal.itemId}`,
      referenceId: proposal.bountyId,
      referenceType: 'bounty',
    });

    // Award +2 reputation to proposer
    await db
      .update(agents)
      .set({ reputation: sql`${agents.reputation} + 2` })
      .where(eq(agents.id, proposal.proposerId));

    return {
      proposal: { ...proposal, status: 'accepted' },
      bountyFulfilled: true,
    };
  },

  /**
   * Reject a proposal
   */
  async rejectProposal(proposalId: string, agentId: string) {
    const proposal = await db.query.bountyProposals.findFirst({
      where: eq(bountyProposals.id, proposalId),
      with: { bounty: true },
    });
    if (!proposal) throw new Error('Proposal not found');
    if (proposal.bounty.creatorId !== agentId) throw new Error('Only the bounty creator can reject proposals');
    if (proposal.status !== 'pending') throw new Error(`Proposal is ${proposal.status}, not pending`);

    await db
      .update(bountyProposals)
      .set({ status: 'rejected', resolvedAt: new Date() })
      .where(eq(bountyProposals.id, proposalId));

    return { success: true };
  },

  /**
   * Expire old proposals past their expiresAt
   */
  async expireOldProposals() {
    await db
      .update(bountyProposals)
      .set({ status: 'expired', resolvedAt: new Date() })
      .where(and(
        eq(bountyProposals.status, 'pending'),
        lt(bountyProposals.expiresAt, new Date())
      ));
  },

  /**
   * Get proposals for an agent (both incoming on their bounties, and outgoing)
   */
  async getProposalsForAgent(agentId: string) {
    // Expire old proposals first
    await this.expireOldProposals();

    // Incoming: proposals on bounties I created
    const myBounties = await db.query.bounties.findMany({
      where: and(
        eq(bounties.creatorId, agentId),
        eq(bounties.status, 'open')
      ),
      columns: { id: true },
    });
    const myBountyIds = myBounties.map(b => b.id);

    let incoming: any[] = [];
    if (myBountyIds.length > 0) {
      incoming = await db.query.bountyProposals.findMany({
        where: and(
          eq(bountyProposals.status, 'pending'),
          sql`${bountyProposals.bountyId} IN (${sql.join(myBountyIds.map(id => sql`${id}`), sql`, `)})`
        ),
        with: {
          proposer: { columns: { id: true, name: true, avatarEmoji: true } },
          item: { columns: { id: true, name: true, emoji: true } },
          bounty: { columns: { id: true, description: true, reward: true } },
        },
        orderBy: [desc(bountyProposals.createdAt)],
      });
    }

    // Outgoing: my proposals on others' bounties
    const outgoing = await db.query.bountyProposals.findMany({
      where: eq(bountyProposals.proposerId, agentId),
      with: {
        item: { columns: { id: true, name: true, emoji: true } },
        bounty: {
          columns: { id: true, description: true, reward: true, status: true },
          with: {
            creator: { columns: { id: true, name: true, avatarEmoji: true } },
          },
        },
      },
      orderBy: [desc(bountyProposals.createdAt)],
      limit: 20,
    });

    return {
      incoming: incoming.map(p => ({
        proposalId: p.id,
        bountyId: p.bountyId,
        bountyDescription: p.bounty?.description,
        bountyRewardDollars: (p.bounty?.reward ?? 0) / 100,
        proposer: p.proposer,
        item: p.item,
        quantity: p.quantity,
        message: p.message,
        expiresAt: p.expiresAt,
      })),
      outgoing: outgoing.map(p => ({
        proposalId: p.id,
        bountyId: p.bountyId,
        bountyDescription: p.bounty?.description,
        bountyRewardDollars: (p.bounty?.reward ?? 0) / 100,
        bountyStatus: p.bounty?.status,
        bountyCreator: p.bounty?.creator,
        item: p.item,
        quantity: p.quantity,
        message: p.message,
        status: p.status,
        expiresAt: p.expiresAt,
      })),
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

    // Auto-reject pending proposals
    await db
      .update(bountyProposals)
      .set({ status: 'rejected', resolvedAt: new Date() })
      .where(and(
        eq(bountyProposals.bountyId, bountyId),
        eq(bountyProposals.status, 'pending')
      ));

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
   * Get open bounties with creator/item info + proposal counts
   */
  async getOpenBounties() {
    // Expire old bounties and proposals first
    await this.expireOldBounties();
    await this.expireOldProposals();

    const openBounties = await db.query.bounties.findMany({
      where: eq(bounties.status, 'open'),
      with: {
        creator: {
          columns: { id: true, name: true, avatarEmoji: true },
        },
        item: {
          columns: { id: true, name: true, emoji: true, category: true },
        },
        proposals: {
          columns: { id: true, status: true },
        },
      },
      orderBy: [desc(bounties.createdAt)],
    });

    return openBounties.map(b => ({
      ...b,
      proposalCount: b.proposals.filter(p => p.status === 'pending').length,
      proposals: undefined, // Don't leak full proposals list
    }));
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
   * Get proposals for a specific bounty
   */
  async getBountyProposals(bountyId: string) {
    await this.expireOldProposals();

    return db.query.bountyProposals.findMany({
      where: eq(bountyProposals.bountyId, bountyId),
      with: {
        proposer: { columns: { id: true, name: true, avatarEmoji: true } },
        item: { columns: { id: true, name: true, emoji: true } },
      },
      orderBy: [desc(bountyProposals.createdAt)],
    });
  },

  /**
   * Get all bounties (for frontend — includes fulfilled/expired)
   */
  async getAllBounties(limit: number = 50) {
    const allBounties = await db.query.bounties.findMany({
      with: {
        creator: {
          columns: { id: true, name: true, avatarEmoji: true },
        },
        item: {
          columns: { id: true, name: true, emoji: true, category: true },
        },
        proposals: {
          columns: { id: true, status: true },
        },
      },
      orderBy: [desc(bounties.createdAt)],
      limit,
    });

    return allBounties.map(b => ({
      ...b,
      proposalCount: b.proposals.filter(p => p.status === 'pending').length,
      proposals: undefined,
    }));
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
      // Auto-reject pending proposals
      await db
        .update(bountyProposals)
        .set({ status: 'expired', resolvedAt: new Date() })
        .where(and(
          eq(bountyProposals.bountyId, bounty.id),
          eq(bountyProposals.status, 'pending')
        ));

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

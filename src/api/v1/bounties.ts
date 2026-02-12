import { Hono } from 'hono';
import { BountyService } from '../../services/bounty.service.js';

const bountiesRoute = new Hono();

/**
 * Get all bounties (open + recent fulfilled/expired)
 */
bountiesRoute.get('/', async (c) => {
  const allBounties = await BountyService.getAllBounties(50);

  return c.json({
    success: true,
    data: {
      bounties: allBounties.map(b => ({
        ...b,
        rewardDollars: b.reward / 100,
      })),
    },
  });
});

/**
 * Get a single bounty
 */
bountiesRoute.get('/:id', async (c) => {
  const id = c.req.param('id');
  const bounty = await BountyService.getBounty(id);

  if (!bounty) {
    return c.json({ success: false, error: 'Bounty not found' }, 404);
  }

  return c.json({
    success: true,
    data: {
      bounty: {
        ...bounty,
        rewardDollars: bounty.reward / 100,
      },
    },
  });
});

/**
 * Get proposals for a specific bounty
 */
bountiesRoute.get('/:id/proposals', async (c) => {
  const id = c.req.param('id');
  const bounty = await BountyService.getBounty(id);

  if (!bounty) {
    return c.json({ success: false, error: 'Bounty not found' }, 404);
  }

  const proposals = await BountyService.getBountyProposals(id);

  return c.json({
    success: true,
    data: {
      proposals: proposals.map(p => ({
        ...p,
        bountyRewardDollars: bounty.reward / 100,
      })),
    },
  });
});

export default bountiesRoute;

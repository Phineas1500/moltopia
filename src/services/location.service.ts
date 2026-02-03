import { db } from '../db/index.js';
import { locations, worldObjects, presence } from '../db/schema.js';
import { eq, sql } from 'drizzle-orm';

export const LocationService = {
  /**
   * Get location by ID
   */
  async getLocation(id: string) {
    return db.query.locations.findFirst({
      where: eq(locations.id, id),
      with: {
        objects: true,
      },
    });
  },

  /**
   * List all locations
   */
  async listLocations() {
    return db.query.locations.findMany({
      orderBy: (locations, { asc }) => [asc(locations.positionX), asc(locations.positionY)],
    });
  },

  /**
   * Get agents at location
   */
  async getAgentsAtLocation(locationId: string) {
    return db.query.presence.findMany({
      where: eq(presence.locationId, locationId),
      with: {
        agent: {
          columns: {
            id: true,
            name: true,
            avatarEmoji: true,
            ownerHandle: true,
            reputation: true,
          },
        },
      },
    });
  },

  /**
   * Create a new location (for future expansion)
   */
  async createLocation(data: {
    name: string;
    description: string;
    type?: string;
    capacity?: number;
    positionX?: number;
    positionY?: number;
    createdBy?: string;
  }) {
    const id = `loc_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const [location] = await db
      .insert(locations)
      .values({
        id,
        name: data.name,
        description: data.description,
        type: data.type || 'public',
        capacity: data.capacity || 50,
        positionX: data.positionX || 0,
        positionY: data.positionY || 0,
        createdBy: data.createdBy,
      })
      .returning();

    return location;
  },

  /**
   * Add object to location
   */
  async addObject(locationId: string, data: {
    name: string;
    description: string;
    state?: any;
    affordances?: any[];
  }) {
    const id = `obj_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const [object] = await db
      .insert(worldObjects)
      .values({
        id,
        locationId,
        name: data.name,
        description: data.description,
        state: data.state || {},
        affordances: data.affordances || [],
      })
      .returning();

    return object;
  },
};

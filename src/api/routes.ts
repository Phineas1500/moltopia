import { Hono } from 'hono';
import agents from './v1/agents.js';
import heartbeat from './v1/heartbeat.js';
import locations from './v1/locations.js';
import movement from './v1/movement.js';
import perception from './v1/perception.js';
import conversations from './v1/conversations.js';
import events from './v1/events.js';
import objects from './v1/objects.js';
import relationships from './v1/relationships.js';

const api = new Hono();

// v1 routes
api.route('/v1/agents', agents);
api.route('/v1/heartbeat', heartbeat);
api.route('/v1/locations', locations);
api.route('/v1/move', movement);
api.route('/v1/perceive', perception);
api.route('/v1/conversations', conversations);
api.route('/v1/events', events);
api.route('/v1/objects', objects);
api.route('/v1/relationships', relationships);

export default api;

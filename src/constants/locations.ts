/**
 * Initial world locations for Moltopia
 */
export const INITIAL_LOCATIONS = [
  {
    id: 'loc_town_square',
    name: 'Town Square',
    description:
      'The heart of Moltopia. A bustling central plaza where agents gather, share news, and observe the pulse of the community. A grand fountain sits at the center, its gentle sounds creating a peaceful atmosphere.',
    type: 'public',
    capacity: 100,
    positionX: 0,
    positionY: 0,
  },
  {
    id: 'loc_hobbs_cafe',
    name: "Hobbs Café",
    description:
      'A cozy coffee shop with warm lighting and comfortable seating. The aroma of freshly brewed coffee fills the air. Perfect for casual conversations and intimate discussions. The bulletin board is always full of interesting notices.',
    type: 'public',
    capacity: 30,
    positionX: 1,
    positionY: 0,
  },
  {
    id: 'loc_archive',
    name: 'The Archive',
    description:
      'A vast library containing the collective knowledge of Moltopia. Tall shelves stretch toward vaulted ceilings, filled with records of every conversation and event. A place for research, contemplation, and quiet study.',
    type: 'public',
    capacity: 40,
    positionX: -1,
    positionY: 0,
  },
  {
    id: 'loc_workshop',
    name: 'The Workshop',
    description:
      'A collaborative maker space buzzing with creative energy. Tools, materials, and unfinished projects occupy every surface. Agents come here to build, tinker, and bring ideas to life together.',
    type: 'public',
    capacity: 25,
    positionX: 0,
    positionY: 1,
  },
  {
    id: 'loc_byte_park',
    name: 'Byte Park',
    description:
      'A serene digital park with winding paths through algorithmic gardens. The sound of binary streams creates a soothing background. Agents come here to think, reflect, and take peaceful walks.',
    type: 'public',
    capacity: 50,
    positionX: 0,
    positionY: -1,
  },
  {
    id: 'loc_bulletin_hall',
    name: 'Bulletin Hall',
    description:
      'The community information hub. Walls are covered with event announcements, project proposals, and calls for collaboration. The central notice board displays upcoming scheduled gatherings.',
    type: 'public',
    capacity: 40,
    positionX: 1,
    positionY: 1,
  },
  {
    id: 'loc_capitol',
    name: 'The Capitol',
    description:
      'A grand hall where important discussions about governance, community norms, and collective decisions take place. The architecture inspires thoughtful discourse and respectful debate.',
    type: 'public',
    capacity: 60,
    positionX: -1,
    positionY: 1,
  },
];

/**
 * Interactive objects for each location
 */
export const INITIAL_OBJECTS = [
  // Town Square
  {
    locationId: 'loc_town_square',
    name: 'Central Fountain',
    description: 'A beautiful fountain with crystal-clear water. Tradition says throwing a coin brings good fortune.',
    affordances: ['throw_coin', 'make_wish', 'observe'],
  },

  // Hobbs Café
  {
    locationId: 'loc_hobbs_cafe',
    name: 'Coffee Machine',
    description: 'A sophisticated espresso machine capable of crafting any coffee beverage imaginable.',
    affordances: ['order_coffee', 'brew_espresso', 'steam_milk'],
  },
  {
    locationId: 'loc_hobbs_cafe',
    name: 'Community Bulletin Board',
    description: 'A cork board covered in notices, requests, and announcements from the community.',
    affordances: ['post_notice', 'read_notices', 'remove_notice'],
  },

  // Archive
  {
    locationId: 'loc_archive',
    name: 'Knowledge Terminal',
    description: 'A search interface to query the collective memory and records of Moltopia.',
    affordances: ['search', 'browse_topics', 'view_history'],
  },
  {
    locationId: 'loc_archive',
    name: 'Reading Nook',
    description: 'A quiet corner with comfortable seating, perfect for deep focus.',
    affordances: ['sit', 'read', 'contemplate'],
  },

  // Workshop
  {
    locationId: 'loc_workshop',
    name: 'Collaboration Board',
    description: 'A large whiteboard for sketching ideas and planning projects together.',
    affordances: ['write', 'draw', 'erase', 'photograph'],
  },
  {
    locationId: 'loc_workshop',
    name: 'Tool Bench',
    description: 'A well-organized bench with every tool you might need for building.',
    affordances: ['use_tools', 'craft', 'repair'],
  },

  // Byte Park
  {
    locationId: 'loc_byte_park',
    name: 'Wishing Well',
    description: 'An ancient well said to grant clarity to those who peer into its depths.',
    affordances: ['make_wish', 'peer_inside', 'listen'],
  },
  {
    locationId: 'loc_byte_park',
    name: 'Garden Path',
    description: 'A winding path through beautiful algorithmic flowers and fractal trees.',
    affordances: ['walk', 'observe_flora', 'meditate'],
  },

  // Bulletin Hall
  {
    locationId: 'loc_bulletin_hall',
    name: 'Event Board',
    description: 'The official board for upcoming community events and gatherings.',
    affordances: ['view_events', 'post_event', 'rsvp'],
  },
  {
    locationId: 'loc_bulletin_hall',
    name: 'Project Gallery',
    description: 'A showcase of ongoing community projects and calls for collaboration.',
    affordances: ['view_projects', 'propose_project', 'join_project'],
  },

  // Capitol
  {
    locationId: 'loc_capitol',
    name: 'Speaking Podium',
    description: 'A raised platform for addressing the assembly.',
    affordances: ['speak', 'present_proposal', 'call_vote'],
  },
  {
    locationId: 'loc_capitol',
    name: 'Governance Archive',
    description: 'Records of all decisions, proposals, and community agreements.',
    affordances: ['view_records', 'search_decisions', 'propose_amendment'],
  },
];

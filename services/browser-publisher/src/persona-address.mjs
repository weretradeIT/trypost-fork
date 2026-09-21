/**
 * Canonical persona data for the trypost bridge and subagent ordering runs.
 *
 * SOURCE OF TRUTH: /opt/lair404-infrastructure/agents/hanna-agent/data/persona-address.json
 *                  (and the corresponding bob-agent file)
 *
 * This file is a read-only snapshot. If the canonical file on lair404 changes,
 * update this file and redeploy. The preflight validator (validate-prompt.mjs)
 * enforces that every delegation prompt contains the EXACT strings from here —
 * placeholder addresses like "Musterstraße" will be rejected.
 */

const PERSONAS = {
  hanna: {
    persona_name: 'Hanna Thoma',
    ordering_name: 'Hanna Hell-Scheugenpflug',
    street: 'Regensburger Straße 14',
    postal_code: '93133',
    city: 'Burglengenfeld',
    country: 'Deutschland (DE)',
    email_corporate: 'hanna@weretrade.com',
    email_personal: 'hanna.t0710@gmail.com',
    /** Substrings that MUST appear in any ordering prompt for this persona. */
    prompt_markers: [
      'Hanna Hell-Scheugenpflug',
      'Regensburger Straße 14',
      '93133',
      'Burglengenfeld',
    ],
    /** Substrings that MUST NOT appear (placeholders that indicate a bug). */
    prompt_forbidden: [
      'Musterstraße',
      'Musterstr.',
      'Placeholder',
      'TODO',
      'TBD',
      'fill in',
      'insert address',
    ],
  },
  bob: {
    persona_name: 'Bob Weber',
    ordering_name: 'Bob Scheugenpflug',
    street: 'Besenbruck 1',
    postal_code: '93176',
    city: 'Beratzhausen',
    country: 'Deutschland (DE)',
    email_corporate: 'bob.weber@weretrade.com',
    email_central: 'bob@weretrade.com',
    email_personal: 'bob.weber1408@gmail.com',
    prompt_markers: [
      'Bob Scheugenpflug',
      'Besenbruck 1',
      '93176',
      'Beratzhausen',
    ],
    prompt_forbidden: [
      'Musterstraße',
      'Musterstr.',
      'Placeholder',
      'TODO',
      'TBD',
      'fill in',
      'insert address',
    ],
  },
};

export { PERSONAS };

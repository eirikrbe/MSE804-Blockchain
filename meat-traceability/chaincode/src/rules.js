'use strict';

/**
 * Roles, species and the thresholds the prototype uses. A participant's role
 * and ID come from the `tr.role` / `tr.id` attributes that the organisation's
 * Fabric CA puts in the user's X.509 certificate.
 */

const ROLE = Object.freeze({
    FARM: 'farm',
    PROCESSOR: 'processor',
    LOGISTICS: 'logistics',
    RETAILER: 'retailer',
    CERTIFIER: 'certifier',
    REGULATOR: 'regulator',
    SENSOR: 'sensor',
});

const SELF_REGISTER_ROLES = Object.freeze([
    ROLE.FARM, ROLE.PROCESSOR, ROLE.LOGISTICS, ROLE.RETAILER, ROLE.CERTIFIER, ROLE.REGULATOR,
]);

// Who can hold physical custody of a lot.
const CUSTODIAN_ROLES = Object.freeze([ROLE.FARM, ROLE.PROCESSOR, ROLE.LOGISTICS, ROLE.RETAILER]);

// Who can own a cold-chain sensor (they must also have custody of the lot it reports on).
const SENSOR_OWNER_ROLES = Object.freeze([ROLE.PROCESSOR, ROLE.LOGISTICS, ROLE.RETAILER]);

// Who can start a recall.
const RECALL_ROLES = Object.freeze([ROLE.REGULATOR, ROLE.PROCESSOR, ROLE.RETAILER]);

const SPECIES = Object.freeze({ BEEF: 'beef', LAMB: 'lamb' });

const KIND = Object.freeze({ ANIMAL: 'animal', CARCASS: 'carcass', PRODUCT: 'product' });

const STATUS = Object.freeze({ OK: 'ok', QUARANTINED: 'quarantined', RECALLED: 'recalled' });

const CREDENTIAL_TYPES = Object.freeze(['halal', 'rmp']);

// ASSUMED values for the prototype, not regulatory limits: the processor can
// set its own limit per product when it creates the lot.
const DEFAULT_MAX_TEMP_C = 4;
const DEFAULT_MAX_EXCURSION_MINUTES = 30;

module.exports = {
    ROLE,
    SELF_REGISTER_ROLES,
    CUSTODIAN_ROLES,
    SENSOR_OWNER_ROLES,
    RECALL_ROLES,
    SPECIES,
    KIND,
    STATUS,
    CREDENTIAL_TYPES,
    DEFAULT_MAX_TEMP_C,
    DEFAULT_MAX_EXCURSION_MINUTES,
};

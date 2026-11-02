// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MeatTrace: beef and lamb traceability prototype (MSE804 Assessment 2)
/// @notice Follows lots of live animals, carcasses and retail products from farm
///         to checkout, with custody, halal credentials, cold-chain batches and
///         recalls. Written for a permissioned EVM network run by a consortium
///         (for example Hyperledger Besu with QBFT consensus). Every business in
///         the tests and demo is fictional.
/// @dev    Design:
///         - The consortium admin onboards each business with a role; the
///           caller's role always comes from that registry, never from arguments.
///         - Every lot links to its parents and children, so one recall walks
///           from a carcass to every pack it ended up in.
///         - A lot can be processed once, and products cannot outweigh their
///           inputs, so nobody can turn one carcass into more product.
///         - Halal is a credential a certifier issues to a processor. A product
///           keeps the claim only if every input came from a halal slaughter;
///           mixing drops it, and revoking the certificate invalidates it.
///         - Cold-chain sensors submit one batch per window (Merkle root and
///           summary). Raw readings stay off-chain; an excursion quarantines
///           the lot.
///         - Personal data never goes on-chain: NAIT numbers and ASD references
///           are stored as a hash, and documents as hashes too.
contract MeatTrace {
    // ------------------------------------------------------------------
    // Types
    // ------------------------------------------------------------------

    enum Role { None, Admin, Farm, Processor, Logistics, Retailer, Certifier, Regulator }
    enum Species { Beef, Lamb }
    enum Kind { Animal, Carcass, Product }
    enum Status { Ok, Quarantined, Recalled }

    struct Participant {
        Role role;
        string name;
        string nzbn;
    }

    struct Credential {
        string credType;      // "halal" or "rmp"
        address subject;      // the processor it covers
        address issuer;       // the certifier
        bytes32 documentHash; // hash of the off-chain certificate
        uint64 issuedAt;
        uint64 expiresAt;
        bool revoked;
    }

    struct Lot {
        string ref;               // GS1 batch or lot code
        Kind kind;
        Species species;
        Status status;
        bool consumed;            // already slaughtered, cut or merged
        address custodian;
        address processor;
        uint64 weightGrams;
        uint32 headCount;
        bytes32 identifiersHash;  // hash of NAIT numbers (beef) or ASD reference (lamb)
        string gtin;
        string product;
        uint64 useBy;
        int16 maxTempTenths;      // 40 = 4.0 °C
        uint16 maxExcursionMinutes;
        uint256[] parents;
        uint256[] children;
        address[] originFarms;
        uint256[] halalCredentials; // empty = no halal claim
        string statusReason;
    }

    struct ProductSpec {
        string ref;
        string gtin;
        string product;
        uint64 weightGrams;
        uint64 useBy;
        int16 maxTempTenths;
    }

    struct BatchInput {
        uint64 windowStart;
        uint64 windowEnd;
        uint32 count;
        bytes32 merkleRoot;
        int16 minTenths;
        int16 maxTenths;
        uint16 minutesAbove;
    }

    struct ColdChainBatch {
        address sensor;
        uint64 windowStart;
        uint64 windowEnd;
        uint32 count;
        bytes32 merkleRoot;
        int16 minTenths;
        int16 maxTenths;
        uint16 minutesAbove;
        bool excursion;
    }

    // ------------------------------------------------------------------
    // State
    // ------------------------------------------------------------------

    /// @notice ASSUMED for the prototype, not a regulatory limit.
    uint16 public constant DEFAULT_MAX_EXCURSION_MINUTES = 30;
    /// @notice Largest family of lots one recall or provenance walk will visit.
    uint256 public constant MAX_WALK = 256;

    bytes32 private constant HALAL = keccak256("halal");
    bytes32 private constant RMP = keccak256("rmp");

    mapping(address => Participant) public participants;
    mapping(address => address) public sensorOwner;

    uint256 public credentialCount;
    mapping(uint256 => Credential) private credentials;
    mapping(address => uint256[]) private credentialsOf;

    uint256 public lotCount;
    mapping(uint256 => Lot) private lots;
    mapping(bytes32 => uint256) private lotIdByRef;
    mapping(uint256 => ColdChainBatch[]) private coldChain;

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------

    event ParticipantRegistered(address indexed account, Role role, string name);
    event SensorRegistered(address indexed sensor, address indexed owner);
    event CredentialIssued(uint256 indexed id, string credType, address indexed subject, address indexed issuer);
    event CredentialRevoked(uint256 indexed id);
    event LotCreated(uint256 indexed id, string ref, Kind kind, address indexed by);
    event Transferred(uint256 indexed id, address indexed from, address indexed to);
    event Slaughtered(uint256 indexed animalLot, uint256[] carcasses, bool halal);
    event Split(uint256 indexed lot, uint256[] products);
    event Merged(uint256[] inputs, uint256 indexed product, bool halalDroppedByMixing);
    event ColdChainRecorded(uint256 indexed lot, address indexed sensor, bytes32 merkleRoot, bool excursion);
    event Quarantined(uint256 indexed lot, address indexed sensor);
    event QuarantineReleased(uint256 indexed lot, string reason);
    event Recalled(uint256 indexed root, uint256[] lots, string reason);

    constructor() {
        participants[msg.sender] = Participant(Role.Admin, "Consortium admin", "");
        emit ParticipantRegistered(msg.sender, Role.Admin, "Consortium admin");
    }

    // ------------------------------------------------------------------
    // Participants, sensors and credentials
    // ------------------------------------------------------------------

    /// @notice The consortium admin onboards a business with its role and NZBN.
    function registerParticipant(address account, Role role, string calldata name, string calldata nzbn) external {
        require(participants[msg.sender].role == Role.Admin, "only the consortium admin registers participants");
        require(account != address(0) && role != Role.None, "invalid participant");
        require(participants[account].role == Role.None && sensorOwner[account] == address(0), "already registered");
        require(bytes(nzbn).length == 13 && _digits(bytes(nzbn)), "nzbn must be 13 digits");
        participants[account] = Participant(role, name, nzbn);
        emit ParticipantRegistered(account, role, name);
    }

    /// @notice A processor, logistics firm or store registers a sensor it owns.
    function registerSensor(address sensor) external {
        Role r = participants[msg.sender].role;
        require(r == Role.Processor || r == Role.Logistics || r == Role.Retailer, "only processors, logistics or retailers own sensors");
        require(sensor != address(0) && sensorOwner[sensor] == address(0) && participants[sensor].role == Role.None,
            "sensor already registered");
        sensorOwner[sensor] = msg.sender;
        emit SensorRegistered(sensor, msg.sender);
    }

    /// @notice A certifier issues a credential (halal or rmp) to a processor.
    function issueCredential(address subject, string calldata credType, bytes32 documentHash, uint64 expiresAt)
        external
        returns (uint256 id)
    {
        require(participants[msg.sender].role == Role.Certifier, "only certifiers issue credentials");
        require(participants[subject].role == Role.Processor, "credentials are issued to processors");
        bytes32 t = keccak256(bytes(credType));
        require(t == HALAL || t == RMP, "credType must be halal or rmp");
        require(expiresAt > block.timestamp, "expiresAt must be in the future");
        id = ++credentialCount;
        credentials[id] = Credential(credType, subject, msg.sender, documentHash, uint64(block.timestamp), expiresAt, false);
        credentialsOf[subject].push(id);
        emit CredentialIssued(id, credType, subject, msg.sender);
    }

    /// @notice Only the issuer can revoke. Products slaughtered under it lose the claim.
    function revokeCredential(uint256 id) external {
        Credential storage c = credentials[id];
        require(c.issuer != address(0), "credential does not exist");
        require(c.issuer == msg.sender, "only the issuing certifier can revoke");
        require(!c.revoked, "already revoked");
        c.revoked = true;
        emit CredentialRevoked(id);
    }

    // ------------------------------------------------------------------
    // Lots: animals, slaughter, cutting, mixing, custody
    // ------------------------------------------------------------------

    /// @notice A farm registers cattle by their NAIT animal numbers.
    function registerBeefLot(string calldata ref, string[] calldata naitIds, uint64 liveWeightGrams)
        external
        returns (uint256 id)
    {
        require(participants[msg.sender].role == Role.Farm, "only farms register animals");
        require(naitIds.length > 0, "beef lots need NAIT animal numbers");
        for (uint256 i; i < naitIds.length; i++) {
            require(bytes(naitIds[i]).length > 0, "empty NAIT number");
        }
        id = _newLot(ref, Kind.Animal, Species.Beef, liveWeightGrams);
        Lot storage l = lots[id];
        l.headCount = uint32(naitIds.length);
        l.identifiersHash = keccak256(abi.encode(naitIds));
        l.originFarms.push(msg.sender);
    }

    /// @notice A farm registers lambs by Animal Status Declaration (sheep are not in NAIT).
    function registerLambLot(string calldata ref, string calldata asdRef, uint32 headCount, uint64 liveWeightGrams)
        external
        returns (uint256 id)
    {
        require(participants[msg.sender].role == Role.Farm, "only farms register animals");
        require(bytes(asdRef).length > 0 && headCount > 0, "lamb lots need an ASD reference and head count");
        id = _newLot(ref, Kind.Animal, Species.Lamb, liveWeightGrams);
        Lot storage l = lots[id];
        l.headCount = headCount;
        l.identifiersHash = keccak256(bytes(asdRef));
        l.originFarms.push(msg.sender);
    }

    /// @notice Hand a lot to the next business in the chain.
    function transferLot(uint256 id, address to) external {
        Lot storage l = _lot(id);
        require(l.custodian == msg.sender, "caller does not hold this lot");
        require(l.status != Status.Recalled, "recalled lots cannot be moved on");
        require(_holdsGoods(participants[to].role), "recipient cannot take custody of goods");
        l.custodian = to;
        emit Transferred(id, msg.sender, to);
    }

    /// @notice A processor slaughters a lot of animals into carcass lots.
    function slaughter(uint256 animalLot, string[] calldata carcassRefs, uint64[] calldata weightsGrams, bool halal)
        external
        returns (uint256[] memory ids)
    {
        require(participants[msg.sender].role == Role.Processor, "only processors slaughter");
        Lot storage parent = _lot(animalLot);
        require(parent.kind == Kind.Animal, "not a lot of live animals");
        _requireProcessable(parent);
        require(carcassRefs.length > 0 && carcassRefs.length == weightsGrams.length, "carcass refs and weights must match");
        uint256 total;
        for (uint256 i; i < weightsGrams.length; i++) {
            total += weightsGrams[i];
        }
        require(total <= parent.weightGrams, "carcasses cannot weigh more than the live animals");
        uint256 cred;
        if (halal) {
            cred = _activeCredential(msg.sender, HALAL);
            require(cred != 0, "no active halal credential");
        }
        parent.consumed = true;
        ids = new uint256[](carcassRefs.length);
        for (uint256 i; i < carcassRefs.length; i++) {
            uint256 cid = _newLot(carcassRefs[i], Kind.Carcass, parent.species, weightsGrams[i]);
            Lot storage c = lots[cid];
            c.processor = msg.sender;
            c.parents.push(animalLot);
            c.originFarms = parent.originFarms;
            if (cred != 0) {
                c.halalCredentials.push(cred);
            }
            parent.children.push(cid);
            ids[i] = cid;
        }
        emit Slaughtered(animalLot, ids, halal);
    }

    /// @notice Cut one carcass (or product) into retail products.
    function splitLot(uint256 id, ProductSpec[] calldata specs) external returns (uint256[] memory ids) {
        require(participants[msg.sender].role == Role.Processor, "only processors cut and pack");
        Lot storage parent = _lot(id);
        require(parent.kind != Kind.Animal, "live animals must be slaughtered first");
        _requireProcessable(parent);
        require(specs.length > 0, "at least one product is required");
        uint256 total;
        for (uint256 i; i < specs.length; i++) {
            total += specs[i].weightGrams;
        }
        require(total <= parent.weightGrams, "products cannot weigh more than their input");
        parent.consumed = true;
        uint256[] memory from = new uint256[](1);
        from[0] = id;
        ids = new uint256[](specs.length);
        for (uint256 i; i < specs.length; i++) {
            ids[i] = _newProduct(specs[i], from);
            parent.children.push(ids[i]);
        }
        emit Split(id, ids);
    }

    /// @notice Combine lots of one species into one product, e.g. trim into mince.
    ///         The product is halal only if every input is.
    function mergeLots(uint256[] calldata inputs, ProductSpec calldata spec)
        external
        returns (uint256 id, bool halalDropped)
    {
        require(participants[msg.sender].role == Role.Processor, "only processors cut and pack");
        require(inputs.length >= 2, "merging needs at least two inputs");
        Species species = _lot(inputs[0]).species;
        uint256 inputGrams;
        bool anyHalal;
        for (uint256 i; i < inputs.length; i++) {
            Lot storage q = _lot(inputs[i]);
            require(q.kind != Kind.Animal, "live animals must be slaughtered first");
            _requireProcessable(q);
            require(q.species == species, "lots of different species cannot be merged");
            for (uint256 j; j < i; j++) {
                require(inputs[j] != inputs[i], "duplicate input");
            }
            inputGrams += q.weightGrams;
            if (q.halalCredentials.length > 0) {
                anyHalal = true;
            }
        }
        require(spec.weightGrams <= inputGrams, "product cannot weigh more than its inputs");
        id = _newProduct(spec, inputs);
        for (uint256 i; i < inputs.length; i++) {
            Lot storage q = lots[inputs[i]];
            q.consumed = true;
            q.children.push(id);
        }
        halalDropped = anyHalal && lots[id].halalCredentials.length == 0;
        emit Merged(inputs, id, halalDropped);
    }

    // ------------------------------------------------------------------
    // Cold chain
    // ------------------------------------------------------------------

    /// @notice A sensor submits one window of readings for a lot its owner holds.
    function submitColdChainBatch(uint256 id, BatchInput calldata b) external returns (bool excursion) {
        address owner = sensorOwner[msg.sender];
        require(owner != address(0), "sensor is not registered");
        Lot storage l = _lot(id);
        require(l.kind == Kind.Product, "cold-chain readings are for product lots");
        require(l.custodian == owner, "sensor owner does not hold this lot");
        require(b.windowEnd >= b.windowStart && b.count > 0 && b.merkleRoot != bytes32(0), "invalid batch");
        excursion = b.maxTenths > l.maxTempTenths && b.minutesAbove > l.maxExcursionMinutes;
        ColdChainBatch storage e = coldChain[id].push();
        e.sensor = msg.sender;
        e.windowStart = b.windowStart;
        e.windowEnd = b.windowEnd;
        e.count = b.count;
        e.merkleRoot = b.merkleRoot;
        e.minTenths = b.minTenths;
        e.maxTenths = b.maxTenths;
        e.minutesAbove = b.minutesAbove;
        e.excursion = excursion;
        emit ColdChainRecorded(id, msg.sender, b.merkleRoot, excursion);
        if (excursion && l.status == Status.Ok) {
            l.status = Status.Quarantined;
            l.statusReason = "temperature excursion";
            emit Quarantined(id, msg.sender);
        }
    }

    /// @notice The regulator releases a quarantined lot after inspection.
    function releaseQuarantine(uint256 id, string calldata reason) external {
        require(participants[msg.sender].role == Role.Regulator, "only the regulator releases quarantine");
        Lot storage l = _lot(id);
        require(l.status == Status.Quarantined, "lot is not quarantined");
        require(bytes(reason).length >= 10, "reason of at least 10 characters required");
        l.status = Status.Ok;
        l.statusReason = "";
        emit QuarantineReleased(id, reason);
    }

    /// @notice Check that a reading belongs to a batch. Same tree as the off-chain
    ///         code: leaf = sha256(0x00 | reading), node = sha256(0x01 | left | right).
    function verifyReading(bytes32 root, bytes32 leaf, bytes32[] calldata proof, bool[] calldata siblingOnLeft)
        external
        pure
        returns (bool)
    {
        require(proof.length == siblingOnLeft.length, "proof length mismatch");
        bytes32 node = leaf;
        for (uint256 i; i < proof.length; i++) {
            node = siblingOnLeft[i]
                ? sha256(abi.encodePacked(bytes1(0x01), proof[i], node))
                : sha256(abi.encodePacked(bytes1(0x01), node, proof[i]));
        }
        return node == root;
    }

    // ------------------------------------------------------------------
    // Recall, point of sale and lookups
    // ------------------------------------------------------------------

    /// @notice Recall a lot and everything made from it, wherever it is now.
    function recall(uint256 id, string calldata reason) external returns (uint256[] memory affected) {
        Role r = participants[msg.sender].role;
        require(r == Role.Regulator || r == Role.Processor || r == Role.Retailer, "only the regulator, processors or retailers recall");
        Lot storage root = _lot(id);
        require(root.status != Status.Recalled, "lot is already recalled");
        require(r == Role.Regulator || root.processor == msg.sender || root.custodian == msg.sender,
            "only the regulator can recall product you neither processed nor hold");
        require(bytes(reason).length >= 10, "reason of at least 10 characters required");
        affected = _walk(id, true);
        for (uint256 i; i < affected.length; i++) {
            Lot storage l = lots[affected[i]];
            if (l.status == Status.Recalled) {
                continue; // already recalled by an earlier recall: keep its first reason
            }
            l.status = Status.Recalled;
            l.statusReason = reason;
        }
        emit Recalled(id, affected, reason);
    }

    /// @notice What a checkout or shelf scan asks: can this pack be sold?
    function checkSaleable(uint256 id)
        external
        view
        returns (bool saleable, bool halalClaim, bool halalValid, string memory reason)
    {
        Lot storage l = _lot(id);
        halalClaim = l.halalCredentials.length > 0;
        halalValid = halalClaim;
        for (uint256 i; i < l.halalCredentials.length; i++) {
            if (credentials[l.halalCredentials[i]].revoked) {
                halalValid = false;
            }
        }
        if (l.kind != Kind.Product) {
            reason = "not a retail product";
        } else if (l.status == Status.Recalled) {
            reason = string.concat("recalled: ", l.statusReason);
        } else if (l.status == Status.Quarantined) {
            reason = l.statusReason;
        } else if (block.timestamp >= l.useBy) {
            reason = "past its use-by date";
        } else if (halalClaim && !halalValid) {
            reason = "halal certificate behind this product has been revoked";
        }
        saleable = bytes(reason).length == 0;
    }

    function getLot(uint256 id) external view returns (Lot memory) {
        return _lot(id);
    }

    function idOf(string calldata ref) external view returns (uint256 id) {
        id = lotIdByRef[keccak256(bytes(ref))];
        require(id != 0, "lot does not exist");
    }

    function getCredential(uint256 id) external view returns (Credential memory) {
        require(credentials[id].issuer != address(0), "credential does not exist");
        return credentials[id];
    }

    function getColdChain(uint256 id) external view returns (ColdChainBatch[] memory) {
        _lot(id);
        return coldChain[id];
    }

    /// @notice Every lot made from `id` (including itself): what a recall would reach.
    function getDescendants(uint256 id) external view returns (uint256[] memory) {
        _lot(id);
        return _walk(id, true);
    }

    /// @notice Every lot `id` was made from (including itself): the provenance chain.
    function getAncestors(uint256 id) external view returns (uint256[] memory) {
        _lot(id);
        return _walk(id, false);
    }

    // ------------------------------------------------------------------
    // Internal
    // ------------------------------------------------------------------

    function _lot(uint256 id) internal view returns (Lot storage l) {
        l = lots[id];
        require(l.custodian != address(0), "lot does not exist");
    }

    function _newLot(string calldata ref, Kind kind, Species species, uint64 weightGrams) internal returns (uint256 id) {
        bytes32 key = keccak256(bytes(ref));
        require(bytes(ref).length >= 3 && bytes(ref).length <= 64, "lot ref must be 3 to 64 characters");
        require(lotIdByRef[key] == 0, "lot ref already exists");
        require(weightGrams > 0, "weight must be positive");
        id = ++lotCount;
        Lot storage l = lots[id];
        l.ref = ref;
        l.kind = kind;
        l.species = species;
        l.custodian = msg.sender;
        l.weightGrams = weightGrams;
        lotIdByRef[key] = id;
        emit LotCreated(id, ref, kind, msg.sender);
    }

    function _newProduct(ProductSpec calldata s, uint256[] memory from) internal returns (uint256 id) {
        bytes memory g = bytes(s.gtin);
        require((g.length == 8 || (g.length >= 12 && g.length <= 14)) && _digits(g), "invalid GTIN");
        require(s.useBy > block.timestamp, "useBy must be in the future");
        require(s.maxTempTenths >= -300 && s.maxTempTenths <= 300, "maxTempTenths out of range");
        id = _newLot(s.ref, Kind.Product, lots[from[0]].species, s.weightGrams);
        Lot storage p = lots[id];
        p.gtin = s.gtin;
        p.product = s.product;
        p.useBy = s.useBy;
        p.maxTempTenths = s.maxTempTenths;
        p.maxExcursionMinutes = DEFAULT_MAX_EXCURSION_MINUTES;
        p.processor = msg.sender;
        bool allHalal = true;
        for (uint256 i; i < from.length; i++) {
            Lot storage q = lots[from[i]];
            p.parents.push(from[i]);
            for (uint256 f; f < q.originFarms.length; f++) {
                _pushUniqueAddress(p.originFarms, q.originFarms[f]);
            }
            if (q.halalCredentials.length == 0) {
                allHalal = false;
            }
        }
        if (allHalal) {
            for (uint256 i; i < from.length; i++) {
                uint256[] storage creds = lots[from[i]].halalCredentials;
                for (uint256 c; c < creds.length; c++) {
                    _pushUniqueId(p.halalCredentials, creds[c]);
                }
            }
        }
    }

    function _requireProcessable(Lot storage l) internal view {
        require(l.custodian == msg.sender, "caller does not hold this lot");
        require(l.status == Status.Ok, "lot is quarantined or recalled");
        require(!l.consumed, "lot has already been processed");
    }

    function _activeCredential(address subject, bytes32 typeHash) internal view returns (uint256) {
        uint256[] storage ids = credentialsOf[subject];
        for (uint256 i; i < ids.length; i++) {
            Credential storage c = credentials[ids[i]];
            if (keccak256(bytes(c.credType)) == typeHash && !c.revoked
                && c.issuedAt <= block.timestamp && c.expiresAt > block.timestamp) {
                return ids[i];
            }
        }
        return 0;
    }

    /// Breadth-first walk over children (down) or parents (up), including the start.
    function _walk(uint256 start, bool down) internal view returns (uint256[] memory out) {
        uint256[] memory buf = new uint256[](MAX_WALK);
        uint256 head;
        uint256 tail;
        buf[tail++] = start;
        while (head < tail) {
            Lot storage l = lots[buf[head++]];
            uint256[] storage next = l.parents;
            if (down) {
                next = l.children;
            }
            for (uint256 i; i < next.length; i++) {
                bool seen;
                for (uint256 k; k < tail; k++) {
                    if (buf[k] == next[i]) {
                        seen = true;
                        break;
                    }
                }
                if (!seen) {
                    require(tail < MAX_WALK, "too many lots for one call");
                    buf[tail++] = next[i];
                }
            }
        }
        out = new uint256[](tail);
        for (uint256 i; i < tail; i++) {
            out[i] = buf[i];
        }
    }

    function _holdsGoods(Role r) internal pure returns (bool) {
        return r == Role.Farm || r == Role.Processor || r == Role.Logistics || r == Role.Retailer;
    }

    function _digits(bytes memory b) internal pure returns (bool) {
        for (uint256 i; i < b.length; i++) {
            if (b[i] < 0x30 || b[i] > 0x39) {
                return false;
            }
        }
        return true;
    }

    function _pushUniqueAddress(address[] storage list, address a) internal {
        for (uint256 i; i < list.length; i++) {
            if (list[i] == a) {
                return;
            }
        }
        list.push(a);
    }

    function _pushUniqueId(uint256[] storage list, uint256 id) internal {
        for (uint256 i; i < list.length; i++) {
            if (list[i] == id) {
                return;
            }
        }
        list.push(id);
    }
}

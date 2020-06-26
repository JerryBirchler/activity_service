const
    NodeCache = require( "node-cache" ),
    cache = new NodeCache(),
    models = require('express-cassandra'),
    util = require('util'),
    log4js = require('log4js'),
    _ = require('lodash'),
    Uuid = require('cassandra-driver').types.Uuid,
    Request = models.instance.Request,
    Request_Index = models.instance.Request_Index,
    _reservedQueryStrings = { limit: true, offset: true, operator: "GE" },
    _baseIndices = {state: true, task_id: true},
    _reservedProperties = { indices: true, foreignKeys: true, lastUpdated: true , current: true},
    _requiredProperties = {},
    _ex = require('../../helpers/exceptions');

const logger = log4js.getLogger('request store');

class Store {
    constructor() {
    }
    async init(config) {
        logger.info(`init`);
        const required = config["required_request_properties"] || ["entity.application", "entity.type", "entity.name", "task.type", "current"];
        required.forEach(property => {
            _requiredProperties[property] = true;
        });
    }
    async get(query) {
        logger.info("get");
        let key_name = "";
        let key_value = "";
        let key_limit = "";
        const opResult = getOperatorValue(query);

        if (opResult.status) {
            return opResult;
        }

        const operator = opResult.operator;
        const opLevel = parseInt(opResult.opLevel, 10);

        let level = 0;
        _.keysIn(query).forEach(key => {
            logger.debug(`get key: [${key}]`);
            if (!_reservedQueryStrings[key]) {
                key_name += (key_name == "") ? key : "," + key;
                const value = query[key];
                key_value += value;
                key_value += "\u0000";
                ///
                /// This concept allows for queries to be limited to supplied key values so that 
                /// I could for example get all entity.name(s) for entity.type="Oracle" without
                /// worrying about spill over into the next type which may be "SQLServer". If the
                /// operation level is set to zero, then none of the results are limited by the key 
                /// values supplied. Whereas in the case presented above, if in that case the top level 
                /// index part was entity.type, then an operation level of one would in fact limit 
                /// the results to let's say "Oracle". This is intended to provide some flexibility
                /// to filter queried results for perhaps a UI display of a list of entities based 
                /// on some criteria. The default operation level is 999, which essentially means that
                /// results are limited to matching all the key values supplied.
                ///
                key_limit += (opLevel > level) ? value : "\uFFFF";
                key_limit += "\uFFFF";
                level++;
            }
        });

        logger.debug(`get key_name: [${key_name}], key_value: [${key_value}], key_limit[${key_limit}], opLevel: [${opLevel}]`);
        const uuids = {};
        const indexes = operator.startsWith("GE")
            ? await Request_Index.findAsync({ key_name, key_value: { '$gte': key_value, '$lte': key_limit } }, { consistency: models.consistencies.local_quorum })
            : await Request_Index.findAsync({ key_name, key_value: { '$gt': key_value, '$lte': key_limit } }, { consistency: models.consistencies.local_quorum });

        ///
        /// Create a unique hash set of all the uuids returned to pair down request queries
        ///        
        indexes.forEach(request => { uuids[request.uuid] = true; });

        ///
        /// Let's batch up all the UUIDs from the index results so that we can get all the requests that 
        /// match. We may need to throttle this if the request payload exceeds some threshold that breaks 
        /// Cassandra Express calls or  because we might want to throttle the number of requests returned
        ///
        const inClause = [];
        for (let uuid in uuids) { inClause.push(Uuid.fromString(uuid)); }
        return await Request.findAsync({ uuid: { '$in': inClause } }, { consistency: models.consistencies.local_quorum });
    }
    async getByuuid(uuid) {
        logger.info("getByuuid");
        if (!uuid)
            return;

        logger.debug(`getByuuid uuid: [${util.inspect(uuid)}]`);

        const request = await Request.findOneAsync({ uuid: Uuid.fromString(uuid) }, { consistency: models.consistencies.local_quorum });
        if (!request)
            return;
        const result = JSON.parse("{}");
        result.uuid = request.uuid;
        result.method = request.method;
        result.url = request.url;
        result.headers = request.headers;
        result.body = request.body;
        result.data = request.data || "{}";
        result.display_message = request.display_message;
        result.state = request.state;
        result.task_id = request.task_id;
        result.created = request.created;
        result.last_write_on_display_message = request.last_write_on_display_message;
        return result;
    }
    async new(request) {
        logger.info("new");
        response = JSON.parse("{}");
        const before = await this.getByuuid(request.uuid);

        if (before && before.uuid) {
            response.status = 409;
            response.message = "Add new request failed: already exists";
            return response;
        }

        request.method = request.method || "POST";
        request.url = request.url || "";
        request.headers = request.headers || "{}";
        request.body = request.body || "";
        request.data = request.data || "{}";
        request.display_message = request.display_message || "";
        request.state = request.state || 0;
        request.task_id = request.task_id || "";
        request.created = request.created || new Date().toISOString();

        const data = JSON.parse(request.data);
        let properties;
        try {
            properties = getProperties(data, true);
        }
        catch (e) {
            response.status = 400;
            response.message = e.message;
            return response;
        }
        const indices = data.indices;
        const keys = buildKeys(request, indices, properties);
        const queries = [];

        ///
        /// Loop through all of the composite indexes and batch up queries to insert them. 
        /// When the composite index contains "current", make sure to chase down the former 
        /// current index for this entity, remove it and update that request to show 
        /// "current": false. This is done so that with a properly formatted query it should
        /// be possible to get an inventory of all current requests by individual entities 
        /// That should be sufficient to merge request status information into a grid control 
        /// in any UI that displays entities.
        ///
        for (let i = 0; i < indices.length; i++) {
            const index = indices[i];
            const parts = index.split(',');

            if (parts.includes("current")) {
                await handleCurrentIndex(properties, parts, queries);
            }
        }

        logger.debug(`new keys: [${util.inspect(keys)}]`);

        queries.push(new Request({
            uuid: Uuid.fromString(request.uuid),
            method: request.method,
            url: request.url,
            headers: request.headers,
            body: request.body,
            data: request.data,
            display_message: request.display_message,
            state: request.state,
            task_id: request.task_id,
            created: request.created
        }).save({ return_query: true }));

        keys.forEach(key => queries.push(new Request_Index(key).save({ return_query: true })));

        await models.doBatchAsync(queries);
        response.status = 201;
        response.message = "Created new request";
        return response;
    }
    async update(after, uuid, before, pendingUpdates) {
        logger.info("update");
        response = JSON.parse("{}");
        const return_queries = before ? true : false;
        before = before || await this.getByuuid(uuid);

        if (!before) {
            response.status = 409;
            response.message = "Update existing request failed: does not exist";
            return response;
        }

        try {
            await lockForUpdate(uuid);
        }
        catch (e) {
            return { "status": e.status, "message": e.message };
        }

        after.uuid = uuid;
        after.method = before.method;
        after.url = before.url;
        after.headers = before.headers;
        after.display_message = after.display_message || before.display_message;
        after.state = after.state || before.state;
        after.task_id = before.task_id;
        after.created = before.created;
        before.uuid = before.uuid.toString();

        logger.debug(`update after: ${util.inspect(after)}`);

        const after_data = JSON.parse(after.data);
        const before_data = JSON.parse(before.data);
        logger.debug(`update after properties`);
        const after_properties = getProperties(after_data, false);
        logger.debug(`update before properties`);
        const before_properties = getProperties(before_data, false);
        const queries = [];

        //========================================
        // update indices where state has changed
        //========================================
        if (has_indices(before_data.indices)) {
            const keys = [];
            let errors = false;
            before_data.indices.forEach(index => {
                logger.debug(`update index: [${util.inspect(index)}] `);
                if (before.state !== after.state && index.split(',').includes("state")) {
                    const batch = buildKey(before, index, before_properties);
                    const interimError = buildKeyObject(before, batch, keys);
                    errors = errors || interimError;
                }
            });

            keys.forEach(key => queries.push(new Request_Index(key).delete({ return_query: true })));

            before_data.indices.forEach(index => {
                logger.debug(`update index: [${util.inspect(index)}] `);
                if (before.state !== after.state && index.split(',').includes("state")) {
                    const batch = buildKey(after, index, before_properties);
                    const interimError = buildKeyObject(after, batch, keys);
                    errors = errors || interimError;
                }
            });

            keys.forEach(key => queries.push(new Request_Index(key).save({ return_query: true })));
            queries.forEach(query => logger.debug(`update query: [${util.inspect(query)}]`));
        }

        //======================================================
        // merge data from before and after and add lastUpdated
        //======================================================
        const data = before_data;

        for (let property in after_properties) {
            logger.debug(`update property: [${property}]`);
            const parts = property.split('.');
            try {
                let data_cursor = data;
                let after_cursor = after_data;
                parts.forEach(part => {
                    if (!data_cursor[part]) {
                        data_cursor[part] = after_cursor[part];
                        throw new _ex.BreakException();
                    }
                    else if (typeof data_cursor[part] !== "object") {
                        data_cursor[part] = after_cursor[part];
                        throw new _ex.BreakException();
                    }

                    data_cursor = data_cursor[part];
                    after_cursor = after_cursor[part];

                    if (typeof data_cursor !== typeof after_cursor) {
                        throw new _ex.IncompatibleTypesException();
                    }

                    if (Array.isArray(data_cursor) !== Array.isArray(after_cursor)) {
                        throw new _ex.IncompatibleTypesException();
                    }

                    if (Array.isArray(data_cursor)) {
                        after_cursor.forEach(item => {
                            if (!data_cursor.includes(item)) {
                                data_cursor.push(item);
                            }
                        });
                        throw new _ex.BreakException();
                    }

                    if (typeof data_cursor !== "object") {
                        data_cursor = after_cursor;
                        throw new _ex.BreakException();
                    }
                });
            }
            catch (e) {
                if (e.status) {
                    if (pendingUpdates)
                        pendingUpdates.forEach(uuid => cache.del(uuid));
                    return { "status": e.status, "message": e.message };
                }
            }
        }

        data.lastUpdated = new Date().toISOString();
        after.data = JSON.stringify(data);
        queries.push(new Request({
            uuid: Uuid.fromString(after.uuid),
            method: after.method,
            url: after.url,
            headers: after.headers,
            body: after.body,
            data: after.data,
            display_message: after.display_message,
            state: after.state,
            task_id: after.task_id,
            created: after.created
        }).save({ return_query: true }));

        if (return_queries) {
            return queries;
        }

        await models.doBatchAsync(queries);
        cache.del(after.uuid);
        response.status = 200;
        response.message = "Updated request";
        return response;
    }
    ///
    /// Dropping properties literally translates into removal of those properties and their descendents
    /// from the JSON payload of the data field for every request returned by the query string provided.
    /// It also means that any index referencing a dropped property has to be adjusted to no longer use
    /// that property or its descendents. This also implies that the former index needs to be deleted 
    /// and that the adjusted index needs to be inserted.
    ///
    async dropProperties(body, query) {
        logger.info("drop properties");
        const drop_data = JSON.parse(body.data || "{}");
        const drop_properties = getProperties(drop_data, false);

        logger.debug(`drop_properties: [${util.inspect(drop_properties)}]`);

        if (Object.keys(drop_properties).length === 0) {
            return { status: 400, message: "Data properties have to be set for droppping" };
        }

        for (let key in drop_properties) {
            if (_requiredProperties[key]) {
                return { status: 400, message: `Cannot drop required property: [${key}]` };
            }
        }

        ///
        /// This uses the query string approach to gathering all the requests we want to drop properties from
        ///
        const requests = await this.get(query);

        ///
        /// If the return value is not an array, it indicates some sort of failure
        ///
        if (!Array.isArray(requests)) {
            return requests;
        }

        const pendingUpdates = [];

        for (let request in requests) {
            request.before = request.data;
            try {
                let uuid = request.uuid.toString();
                await lockForUpdate(uuid);
                pendingUpdates.push(uuid);
                const request_data = JSON.parse(request.data);
                const request_properties = getProperties(request_data, false);
                const dropped_properties = {};

                for (let property in request_properties) {
                    const parts = property.split('.');
                    let request_cursor = request_data;
                    let drop_cursor = drop_data;
                    let partial = "";

                    try {
                        parts.forEach(part => {
                            partial += (partial === "") ? part : "." + part;
                            const request_value = request_cursor[part];
                            const drop_value = drop_cursor[part];

                            logger.debug(`partial: [${partial}], request_value: [${util.inspect(request_value)}], drop_value: [${util.inspect(drop_value)}]`);

                            if (drop_value) {
                                if (typeof drop_value !== "object" && typeof request_value === "object" && !Array.isArray(request_value)) {
                                    if (_reservedProperties[partial]) {
                                        throw new _ex.ReserverdPropertyException(partial);
                                    }

                                    delete request_value[drop_value];
                                    dropped_properties[partial + "." + drop_value] = true;
                                    throw new _ex.BreakException();
                                }

                                if (Array.isArray(drop_value) && Array.isArray(request_value)) {
                                    drop_value.forEach(drop_item => {
                                        const index = request_value.indexOf(drop_item);

                                        if (index > -1) {
                                            request_value.splice(index, 1);
                                        }
                                    });

                                    throw new _ex.BreakException();
                                }

                                if (_reservedProperties[partial]) {
                                    throw new _ex.ReserverdPropertyException(partial);
                                }

                                if (typeof drop_value !== "object") {
                                    delete request_cursor[part];
                                    dropped_properties[partial] = true;
                                    throw new _ex.BreakException();
                                }

                                request_cursor = request_value;
                                drop_cursor = drop_value;
                            }
                        });
                    }
                    catch (e) {
                        if (e.status) {
                            pendingUpdates.forEach(uuid => cache.del(uuid));
                            return { "status": e.status, "message": e.message };
                        }
                    }
                }

                ///
                /// Remove parts of any composite indexes where a property or its descendents are being dropped
                /// For example, consider this the before composite index: 
                ///     entity.type,entity.name,entity.options
                /// 
                /// if we are dropping the entity.options property then the above index is adjusted as follows:
                ///     entity.type,entity.name
                ///
                const indices = request_data["indices"];
                if (has_indices(indices)) {
                    ///
                    /// we canot use a forEach lambda here because we may have to rebuild the index content
                    ///
                    for (let i = 0; i < indices.length; i++) {
                        const index = indices[i];
                        const parts = index.split(',');
                        let alteredParts = false;

                        for (let dropped_property in dropped_properties) {
                            let splicing = true;

                            while (splicing) {
                                splicing = false;

                                for (let p = 0; p < parts.length; p++) {
                                    const part = parts[p];
                                    ///
                                    /// Remove the dropped property and any of its descendents.
                                    /// Short circuit the "while" loop if there are no more properties 
                                    /// to drop. Let's not try to be tricky here. If we splice at least 
                                    /// once then let's break and just go through the remaining parts 
                                    /// all over again to keep the splicing logic simple.
                                    ///
                                    if (part === dropped_property || part.startsWith(dropped_property + ".")) {
                                        parts.splice(p, 1);
                                        alteredParts = true;
                                        splicing = true;
                                        break;
                                    }
                                }
                            }
                        }

                        if (alteredParts) {
                            indices[i] = parts.join(',');
                        }
                    }
                }

                ///
                /// Do a final check to see if we have retained all our required prorperties
                ///
                try {
                    getProperties(request_data, true);
                }
                catch (e) {
                    pendingUpdates.forEach(uuid => cache.del(uuid));
                    return { "status": e.status, "message": e.message };
                }
            }
            catch (e) {
                pendingUpdates.forEach(uuid => cache.del(uuid));
                return { "status": e.status, "message": e.message };
            }

            logger.debug(`request_data: [${util.inspect(request_data)}]`);
        }

        const queries = [];
        for (let after in requests) {
            const before_data = after.before_data || "{}";
            delete after.before_data;
            const before = {
                uuid: after.uuid,
                method: after.method,
                url: after.url,
                headers: after.headers,
                body: after.body,
                data: before_data,
                display_message: after.display_message,
                state: after.state,
                task_id: after.task_id,
                created: after.created
            };

            /// append all the update queries and indexes
            ///
            try {
                queries.push(...await this.update(after, after.uuid, before));
            }
            catch (e) {
                pendingUpdates.forEach(uuid => cache.del(uuid));
                return { "status": e.status, "message": e.message };
            }
        }

        await models.doBatchAsync(queries);
        pendingUpdates.forEach(uuid => cache.del(uuid));
        return { status: 200, message: "Properties have been dropped, and any indexes have been rebuilt" };
    }
}

async function lockForUpdate(uuid) {
    const min_interval = 1;
    const max_interval = 1500;
    let previous_interval = min_interval;
    let current_interval = min_interval;
    let next_interval = min_interval;

    while (cache.get(uuid) && current_interval < max_interval) {
       await sleep(current_interval);
       next_interval = previous_interval + current_interval;
       previous_interval = current_interval;
       current_interval = next_interval;
    }

    if (cache.get(uuid)) {
        throw new _ex.TimeoutException("request", uuid);
    }

    cache.set(uuid);
}

function has_indices(indices) {
    return indices && Array.isArray(indices) && indices.length > 0;
};

///
/// This gets the operator value and level for a index query
/// Operator values are limited to GE for greater than or equal to and GT for greater than
/// Operator level is any integer 0 through 999. This parameter is meant to limit results on 
/// a key part to its key value based on its index + 1 into the composite index. For example, 
/// if the composite key is entity.application,entity.type,entity.name and the operation level 
/// is set to 2, then if we are querying for 'Demo\u0000\Oracle\u0000\dfw01ora001\u0000', we can
/// expect to get results limited to entity.type="Oracle" even though "SQLServer" might be the 
/// next key value ahead of "Oracle".
///
function getOperatorValue(query) {
    const operator = query["operator"] || _reservedQueryStrings["operator"];
    let opLevel = 999;
    
    if (operator.startsWith("GE") || operator.startsWith("GT")) {
        if (operator.length > 2) {
            const level = operator.substring(2);
            if (!isNaN(level)) {
                opLevel = parseInt(level, 10);
            }
        }  
        return { operator: operator, opLevel: opLevel}      
    } 
        
    return { status: 400, message: "Invalid operator. Operator can be of format GE[0-9]+ or GT[0-9]+" };
};

/// The properties collection accounts for each value level property in the data JSON payload.
/// A value level property is one whose value is a primative type or Array List. The access to 
/// a property uses a DOT notation to account for each level of hierarchy seen in the JSON payload. 
/// For example given the application key below, the property would be "entity.application":
///
///     {
///         "entity": {
///             "application": "demo"
///         }
///     }
///
/// This properties list is meant to facilitate various operations needed to validate index parts
/// and supply values where needed.
///
function getProperties(data, checkRequired) {
    const properties = {}; 
    for (let key in data) {
        getChildren(properties, null, data[key], key);
    }

    if (checkRequired) {
        for (let key in _requiredProperties) {
            logger.debug(`getProperties required key: [${key}]`);
            if (!properties[key]) {
                throw new _ex.MissingRequiredPropertyException(key);
            }
        }
    }
    
    for (let key in properties) {        
        logger.debug(`property key: [${key}], value: [${properties[key]}]`);
    }

    return properties;
    
    ///
    /// properties is our hash set of property names with corresponding values
    ///
    /// partial represents the descendant path of a partially qualified property name 
    /// as we descend into its parts, or it may in fact be the fully qualified property.
    ///
    /// cursor for lack of a better term is the object reference holding the descendent 
    /// properties that are at the same partial property name level as we recurse.
    ///
    /// key is the current key sampled to see what sort of object type it is
    ///
    function getChildren(properties, partial, cursor, key) {;
        ///
        /// A key will be a number when it is an index into an array
        ///
        if (isNaN(key)) {
            partial = (partial === null) ? key : partial + "." + key;
        } 
        if (typeof cursor === "object") {
            ///
            /// If the current cursor is an object it has descendent parts
            /// BTW, an array is also considered an Object, this is why we
            /// check keys to see if they are not a number as we recurse.
            ///
            for (let child in cursor) {
                getChildren(properties, partial, cursor[child], child);
            }
        } else if (isNaN(key)) {
            properties[partial] = cursor;
        } else {
            ///
            /// This is that special case where the key is actually just an index 
            /// in an array
            ///
            if (key == 0) {
                properties[partial] = [];    
            }
            properties[partial][key] = cursor;
        }
    }    
}

function buildKeys(request, indices, properties) {
    const keys = [];
    let errors = false;

    if (has_indices(indices)) { 
        indices.forEach(index => {
            const batch = buildKey(request, index, properties);
            const interimError = buildKeyObject(request, batch, keys);
            errors = errors || interimError;
        });
    }

    if (errors) {
        throw {message: `Errors building indices for request with uuid: [${request.uuid}]`};
    }

    return keys;
}

///
/// This completes the key values and pushes them into an array of keys for batch proccessing
///
function buildKeyObject(request, batch, keys) {
    if (batch) {
        batch.forEach(item => {
            logger.debug(`item: [${util.inspect(item)}]`);
            keys.push({ key_name: item.key_name, key_value: item.key_value, created: request.created, uuid: Uuid.fromString(request.uuid) });            
        });   
        return false 
    } 

    return true;    
}

///
/// This creates the composite key values separating parts with a zero character code
///
function buildKey(request, index, properties) {
    const key_name = index;
    let errors = false;
    let key_value = "";
    const key = { key_name: key_name, key_value: key_value };
    const batch = [ key ];
    const parts = index.split(',');
    logger.debug(`index: [${index}]`);

    parts.forEach(part => {
        logger.debug(`part: [${part}]`);
        if (_baseIndices[part]) {                    
            batch.forEach(item => {
                item.key_value += request[part];
                item.key_value += '\u0000';    
                logger.debug(`item: [${util.inspect(item)}]`);
            });
        } else {
            ///
            /// This is how to access a data key that has the same name as a field
            /// in the normal schema
            ///
            if (part.startsWith("data.")) {
                const subpart = part.substring(5);
                errors = errors || buildValue(properties, subpart, batch);
            } else if (properties[part]) {
                errors = errors || buildValue(properties, part, batch);
            } else {
                logger.warn(`new request index build failure: key_value part could not be assigned for '${part}' for key_name: ${key_name}`);
                errors = true;
            }                  
        }            
    });

    return errors ? null : batch;
}

function buildValue(properties, part, batch) {
    logger.debug(`batch: [${util.inspect(batch)}]`);
    const value = properties[part];
    if (value) {
        if (!Array.isArray(value)) {
            if (part !== "current") {
                batch.forEach(item => {
                    item.key_value += value;
                    item.key_value += '\u0000';    
                });    
            }
            return false;
        }
        if (value.length > 0) {            
            const new_batch = [];
            batch.forEach(item => {
                logger.debug(`item: [${util.inspect(item)}]`);
                value.forEach(array_value => {
                    const new_key = { key_name: item.key_name, key_value: item.key_value };                    
                    new_key.key_value += array_value;
                    new_key.key_value += '\u0000';    
                    new_batch.push(new_key);
                });
            });
            logger.debug(`new_batch: [${util.inspect(new_batch)}]`);
            batch.length = 0;
            new_batch.forEach(item => batch.push(item));
            logger.debug(`batch: [${util.inspect(batch)}]`);
            return false;   
        }
    } 
    const key_name = batch[0].key_name;
    logger.warn(`new request index build failure: key_value part could not be assigned for '${part}' for key_name: ${key_name}`);
    return true;
}

async function handleCurrentIndex(properties, parts, queries) {
    let key_name = "";
    let key_value = "";

    parts.forEach(key => {
        key_name += (key_name === "") ? key : "," + key;
        if (key !== "current") {
            const value = properties[key];
            key_value += value;
            key_value += "\u0000";
            logger.debug(`handleCurrentIndex key_value: ${key_value}`);
        }
    });

    logger.debug(`handleCurrentIndex request_index key_name: [${key_name}], key_value: [${key_value}]`);
    const request_index = await Request_Index.findOneAsync({ key_name, key_value: { '$eq': key_value }}, { consistency: models.consistencies.local_quorum });
    
    if (request_index) {
        const before = await Request.findOneAsync({ uuid: request_index.uuid}, { consistency: models.consistencies.local_quorum });
        
        if (before) {
            const uuid = request_index.uuid;
            logger.debug(`handleCurrentIndex uuid: ${uuid}`);                            
            const before_data = JSON.parse(before.data || "{}");
            
            if (before_data.current) {
                before_data.current = false;
                before.data = JSON.stringify(before_data);
            }
            ///
            /// Delete the index for what was the current record
            ///
            queries.push(new Request_Index({
                key_name: request_index.key_name,
                key_value: request_index.key_value,
                created: request_index.created,
                uuid: request_index.uuid
            }).delete({ return_query: true }));
            ///
            /// Update the former request to no longer show as current
            ///
            queries.push(new Request({
                uuid: before.uuid,
                method: before.method,
                url: before.url,
                headers: before.headers,
                body: before.body,
                data: before.data,
                display_message: before.display_message,
                state: before.state,
                task_id: before.task_id,
                created: before.created                                
            }).save({ return_query: true }));       
        }
    }
};

module.exports = {
    new: () => new Store()
};
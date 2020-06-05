const
    models = require('express-cassandra'),
    util = require('util'),
    log4js = require('log4js'),
    _ = require('lodash'),
    config = require('config')["access-code"],
    Uuid = require('cassandra-driver').types.Uuid,
    validate = require('uuid-validate'),
    Request = models.instance.Request,
    Request_Index = models.instance.Request_Index,
    _reservedQueryStrings = { limit: true, offset: true, operator: "GE" },
    _baseIndices = {state: true, task_id: true},
    _notbaseIndices = {indices: true, foreignKeys: true, created: true, uuid: true};

const logger = log4js.getLogger('activity-service-store');

function Store() {
}

Store.prototype.init = async function () {
    logger.info("Store init called");
};

Store.prototype.get = async function (query) {
    logger.info("Store get called");
    let key_name = "";
    let key_value = "";
    let key_limit = "";
    const operator = query["operator"] || _reservedQueryStrings["operator"];
    let opLevel = 999;
    
    if (operator.startsWith("GE") || operator.startsWith("GT")) {
        if (operator.length > 2) {
            const level = operator.substring(2);
            if (!isNaN(level)) {
                opLevel = parseInt(level, 10);
            }
        }        
    }

    let level = 0;
    _.keysIn(query).forEach(key => {
        logger.debug(`Store get key: [${key}]`);
        if (!_reservedQueryStrings[key]) {
            key_name += (key_name == "") ? key : "," + key;
            const value = query[key];
            key_value += value;
            key_value += "\u0000";
            key_limit += (opLevel > level) ? value : "\uFFFF";
            key_limit += "\uFFFF";
            level++;
        }
    });

    logger.debug(`Store get key_name: [${key_name}], key_value: [${key_value}], key_limit[${key_limit}], opLevel: [${opLevel}]`);
    const uuids = {}
    const indexes = operator.startsWith("GE") 
        ? await Request_Index.findAsync({ key_name, key_value: { '$gte': key_value, '$lte': key_limit }}, { consistency: models.consistencies.local_quorum })
        : await Request_Index.findAsync({ key_name, key_value: { '$gt': key_value, '$lte': key_limit }}, { consistency: models.consistencies.local_quorum });

    indexes.forEach(request => {
        uuids[request.uuid] = true;
    });
    const inClause = [];        
    for (let uuid in uuids) {
        inClause.push(Uuid.fromString(uuid));
    }
    return await Request.findAsync({uuid: { '$in': inClause }}, { consistency: models.consistencies.local_quorum });
}

Store.prototype.getByuuid = async function (uuid) {
    logger.info("Store getByuuid called");
    if (!uuid) return;

    logger.debug(`uuid: [${util.inspect(uuid)}]`);

    const request = await Request.findOneAsync({ uuid: Uuid.fromString(uuid) }, { consistency: models.consistencies.local_quorum });
    if (!request) return;
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
    return result;
};

function getProperties(data) {
    const properties = {}; 
    for (let key in data) {
        getChildren(properties, null, data[key], key);
    }
    
    for (let key in properties) {
        logger.debug(`property key: [${key}], value: [${properties[key]}]`);
    }

    return properties;
    
    function getChildren(properties, stem, hook, key) {;
        if (isNaN(key)) {
            stem = (stem === null) ? key : stem + "." + key;
        } 
        if (typeof hook === "object") {
            for (let child in hook) {
                getChildren(properties, stem, hook[child], child);
            }
        } else if (isNaN(key)) {
            properties[stem] = hook;
        } else {
            if (key == 0) {
                properties[stem] = [];    
            }
            properties[stem][key] = hook;
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
        throw exception(`Errors building indices for request with uuid: [${uuid}]`);
    }

    return keys;
}

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
            if (part.startsWith("data.")) {
                const subpart = part.substring(5);
                errors = errors || buildValue(properties, subpart, batch);
            } else if (properties[part]) {
                errors = errors || buildValue(properties, part, batch);
            } else {
                log.warn(`new request index build failure: key_value part could not be assigned for '${part}' for key_name: ${key_name}`);
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
            batch.forEach(item => {
                item.key_value += value;
                item.key_value += '\u0000';    
            });
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
    log.info(`new request index build failure: key_value part could not be assigned for '${part}' for key_name: ${key_name}`);
    return true;
}

Store.prototype.new = async function (request) {
    logger.info("Store new called");
    response = JSON.parse("{}")
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
    const properties = getProperties(data);
    const indices = data.indices;
    const keys = buildKeys(request, indices, properties);    
    
    logger.debug(`keys: [${util.inspect(keys)}]`);    

    const queries = [];
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
};

Store.prototype.update = async function (after, uuid) {
    logger.info("Store update called");
    response = JSON.parse("{}")
    const before = await this.getByuuid(uuid);
    
    if (!before) {
        response.status = 409;
        response.message = "Update existing request failed: does not exist";
        return response;
    
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

    logger.debug(`Store update after: ${util.inspect(after)}`)

    const after_data = JSON.parse(after.data);
    after_data.lastUpdated = after_data.lastUpdated || new Date().toISOString();

    const before_data = JSON.parse(before.data);
    const after_properties = getProperties(after_data);
    const before_properties = getProperties(before_data);
    const queries = [];

    //========================================
    // update indices where state has changed
    //========================================
    if (has_indices(before_data.indices)) {
        const keys = [];
        let errors = false;
        before_data.indices.forEach(index => {
            logger.debug(`Store update index: [${util.inspect(index)}] `);
            if (before.state !== after.state && index.split(',').includes("state")) {
                const batch = buildKey(before, index, before_properties);
                const interimError = buildKeyObject(before, batch, keys);
                errors = errors || interimError;
            }
        });
        
        keys.forEach(key => queries.push(new Request_Index(key).delete({ return_query: true })));

        before_data.indices.forEach(index => {
            logger.debug(`Store update index: [${util.inspect(index)}] `);
            if (before.state !== after.state && index.split(',').includes("state")) {
                const batch = buildKey(after, index, before_properties);
                const interimError = buildKeyObject(after, batch, keys);
                errors = errors || interimError;
            }
        });

        keys.forEach(key => queries.push(new Request_Index(key).save({ return_query: true })));
        queries.forEach(query => logger.debug(`Store update query: [${util.inspect(query)}]`));
    }

    //======================================================
    // merge data from before and after and add lastUpdated
    //======================================================
    const data = before_data;
    for (let property in after_properties) {
        logger.debug(`Store update property: [${property}]`);
        const parts = property.split('.');
        try {
            let data_cursor = data;
            let after_cursor = after_data;
            var BreakException = {};
            var IncompatibleTypesException = { message: "Incompatible type merging data JSON." };
            parts.forEach(part => {
                if (!data_cursor[part])  {
                    data_cursor[part] = after_cursor[part];
                    throw BreakException;
                }      
                data_cursor = data_cursor[part];
                after_cursor = after_cursor[part];
                if (typeof data_cursor !== typeof after_cursor) {
                    throw IncompatibleTypesException;
                }
                if (Array.isArray(data_cursor) !== Array.isArray(after_cursor)) {
                    throw IncompatibleTypesException;
                }
                if (Array.isArray(data_cursor)) {
                    after_cursor.forEach(item => {
                        if (!data_cursor.includes(item)) {
                            data_cursor.push(item);
                        }
                    });
                    throw BreakException;
                } 
                if (typeof Array.data_cursor !== "object" ) {
                    data_cursor = after_cursor;
                    throw BreakException;
                }
            });
        } catch(e) {
            if (e !== BreakException) throw e;
        }
    }

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
    await models.doBatchAsync(queries);

    response.status = 200;
    response.message = after;
    return response;
};

function has_indices(indices) {
    return indices && Array.isArray(indices) && indices.length > 0;
};

module.exports = {
    new: () => new Store()
};

const
    models = require('express-cassandra'),
    util = require('util'),
    log4js = require('log4js'),
    _ = require('lodash'),
    config = require('config')["access-code"],
    Uuid = require('cassandra-driver').types.Uuid,
    Request = models.instance.Request,
    Request_Index = models.instance.Request_Index,
    _baseIndices = {state: true, task_id: true},
    _notbaseIndices = {indices: true, foreignKeys: true, created: true, uuid: true};

const logger = log4js.getLogger('activity-service-store');

function Store() {
}

Store.prototype.init = async function () {
    logger.info("Store init called");
};

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
        for (let i = 0; i < indices.length; i++) {
            const index = indices[i];
            const key_name = index;
            let key_value = "";
            const key = { key_name: key_name, key_value: key_value };
            const batch = [ key ];
            const parts = index.split(',');
            logger.debug(`index: [${index}]`);

            for (let p = 0; p < parts.length; p++) {
                const part = parts[p];
                logger.debug(`part: [${part}]`);
                if (_baseIndices[part]) {                    
                    for (let it = 0; it < batch.length; it++) {
                        const item = batch[it];
                        item.key_value += request[part];
                        item.key_value += ",";    
                        logger.debug(`item: [${util.inspect(item)}]`);
                    }
                } else {
                    if (part.startsWith("data.")) {
                        const subpart = part.substring(5);
                        errors = errors || buildValue(properties, subpart, batch);
                    } else if (properties[part]) {
                        errors = errors || buildValue(properties, part, batch);
                    } else {
                        log.info(`new request index build failure: key_value part could not be assigned for '${part}' for key_name: ${key_name}`);
                        errors = true;
                    }                  
                }            
            }
            for (let i = 0; i < batch.length; i++) {
                const item = batch[i];
                logger.debug(`item: [${util.inspect(item)}]`);
                const len = item.key_value.length - 1;
                const key_value = item.key_value.substr(0, len);
                keys.push({ key_name: item.key_name, key_value: key_value, created: request.created, uuid: Uuid.fromString(request.uuid) });            
            }
        }      
    }

    if (errors) {
        throw exception(`Errors building indices for request with uuid: [${uuid}]`);
    }

    return keys;

    function buildValue(properties, part, batch) {
        logger.debug(`batch: [${util.inspect(batch)}]`);
        const value = properties[part];
        if (value) {
            if (!Array.isArray(value)) {
                for (let i = 0; i < batch.length; i++) {
                    const item = batch[i];
                    item.key_value += value;
                    item.key_value += ",";    
                }
                return false;
            }
            if (value.length > 0) {            
                const new_batch = [];
                for (let i = 0; i < batch.length; i++) {
                    const item = batch[i];
                    logger.debug(`item: [${util.inspect(item)}]`);
                    for (let a = 0; a < value.length; a++) {
                        const array_value = value[a];
                        const new_key = { key_name: item.key_name, key_value: item.key_value };                    
                        new_key.key_value += array_value;
                        new_key.key_value += ",";    
                        new_batch.push(new_key);
                    }
                }
                logger.debug(`new_batch: [${util.inspect(new_batch)}]`);
                batch.length = 0;
                for (let i = 0; i < new_batch.length; i++) {
                    const item = new_batch[i];
                    batch.push(item);
                } 
                logger.debug(`batch: [${util.inspect(batch)}]`);
                return false;   
            }
        } 
        const key_name = batch[0].key_name;
        log.info(`new request index build failure: key_value part could not be assigned for '${part}' for key_name: ${key_name}`);
        return true;
    }
}

Store.prototype.new = async function (request) {
    logger.info("Store new called");
    let queries = [];

    request.method = request.method || "POST";
    request.url = request.method || "";
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

    for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        queries.push(new Request_Index(key).save({ return_query: true }));
    }

    await models.doBatchAsync(queries);
};


function deleteQueryByKey(name, value, created, uuid) {
    const payload = {
        key_name: name,
        key_value: value,
        created: created,
        uuid: id
    };
    
    return new RequestByKey(payload).delete({ return_query: true });
};


function saveQueryByKey(name, value, created, uuid) {
    const payload = {
        key_name: name,
        key_value: value,
        created: created,
        uuid: uuid
    };

    const query = new RequestByKey(payload).save({ return_query: true });
    logger.debug(util.inspect(query));
    return query;

};

function has_indices(indices) {
    return indices && Array.isArray(indices) && indices.length > 0;
}

function deleteQueriesByKey(queries, before, after, attr_type) {
    const before_indices = before.data[indices];
    const after_indices = after.data[indices];
    if (has_indices(before_indices)) {
        before_keys = buildKeys(before, before_indices, )
        if (!has_indices(after_indices)) {
            // delete them all
            before_items.forEach(before_item => {
                queries.push(this.deleteQueryByKey(
                    attr_type,
                    before_item,
                    before.id));
            });
        } else {
            // or delete the ones no longer on the list as of the update
            const after_items = this.makeArray(after.attrs[attr_type]);
            before_items.forEach(before_item => {
                if (!after_items.includes(before_item)) {
                    queries.push(this.deleteQueryByKey(
                        attr_type,
                        before_item,
                        before.id));
                }
            });
        }
    }
};

Store.prototype.deleteQueriesByKeys = function (queries, before, after) {
    for (let key in attrs) {
        this.deleteQueriesByKey(queries, before, after, attrs[key]);
    }
};

Store.prototype.saveQueriesByKeys = function (queries, after, id) {
    for (let key in attrs) {
        this.saveQueriesByKey(queries, after, id, attrs[key]);
    }
};

Store.prototype.makeArray = function(data) {
    if (Array.isArray(data)) return data;
    data = "" + data;
    return data.split(',');

};

Store.prototype.saveQueriesByKey = function(queries, attrs, id, attr_type) {
    if (attrs[attr_type]) {
        let items = this.makeArray(attrs[attr_type]);
        // remember repetitive inserts are upserts in cassandra, this won't hurt you
        // and it also mends the data where this logic was previously flawed
        items.forEach(item => {
            queries.push(this.saveQueryByKey(
                attr_type,
                item,
                id));
        });
    }
};

Store.prototype.update = async function (uuid, after) {
    let queries = [];

    if (after.uuid && after.uuid !== uuid) {
        after.error = { type: 400, message: 'UUID doesn\'t match.' };
        return after;
    }
    // Force the id
    if (!after.uuid) after.uuid = uuid;

    // Get the existing record
    const record = await Request.findOneAsync({ uuid });
    // If we didn't get a record, then return undefined
    if (!record) return;

    let before = JSON.parse(record.data);
    before.state = record.state;

    // Enforcing access-code not to be updated through update
    after.access_code = undefined;
    if(before.access_code) {
        after.access_code = before.access_code;
    }

    if (before.attrs) {
        this.deleteQueriesByKeys(queries, before, after);
    }

    if (after.attrs) {
        this.saveQueriesByKeys(queries, after.attrs, id);
    }

    //await this.createConsolidatedAccountQueries(queries, before, after)

    logger.debug(util.inspect(queries));
    await models.doBatchAsync(queries);

    // Return it
    return after;
};



// Service Now account id
Store.prototype.getbyKey = async function (key, value) {
    let query = { key_name: key, key_value: value };
    // Explicityly checking the value here instead of relying on falsy'ness. `false` is a value
    // value for `value`.
    if (value === "" || value === undefined || value === null){
        delete query.key_value;
    }
    let results = await RequestByKey.findAsync(query);
    if (!results || results.length === 0) return [];
    let idList = results.map(acct => acct.acct_id);
    return await this.getByIdList(idList);
};



module.exports = {
    new: () => new Store()
};

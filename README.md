## Dynamic indexing on request objects
One of the key features of this service is that it allows the user to insert multiple
composite indexes when adding a request. 

The code behind the API call translates each of the fields into a properties list using a dot notation to convey hierarchy.
Here is a concrete example:
<pre>
{
    "indices": [ "entity.type,entity.name,entity.options,state", "state" ],
    "entity": {
        "type": "SqlServer",
        "name": "dfw01sql001",
        "options": ["backup", "shrink", "re-index"]
    }
}
</pre>

Here the properties list look like this:
<pre>
{
    indices: ["entity.type,entity.name,entity.options,state", "state"],
    entity.type: "SqlServer",
    entity.name: "dfw01sql001",
    entity.options: ["backup", "shrink", "re-index"]
}
</pre>

The indices collection is a reserved field. It has a comma separated list of "entity.type" which is "SqlServer", "entity.name" which is "dfw01sql001" and "entity.options" which are "backup", "shrink", "re-index". The state field is in the record itself and is a numeric value of 0, 1 or 2. 0 means intiated a request, 1 means recieved a status update, 2 means complete. When adding this request, 4 indexes will be added as follows:

<pre>
key_name: "entity.type,entity.name,entity.options,state", key_value: "SqlServer\u0000dfw01sql001\u0000backup\u00000\u0000" ...
key_name: "entity.type,entity.name,entity.options,state", key_value: "SqlServer\u0000dfw01sql001\u0000shrink\u00000\u0000" ...
key_name: "entity.type,entity.name,entity.options,state", key_value: "SqlServer\u0000dfw01sql001\u0000re-index\u00000\u0000" ...
key_name: "state", key_value: "0\u0000" ...
</pre>

All four of these also include the created date and the request uuid where the created date is clustered in descending order.

Fields in the composite index are delimited by a hex zero character. This virtually eliminates any possible collisions from other indices. It also means that it is very difficult to use a simple CQL editor to get at this data.

These indexes are optimized to look for initiated requests. When a request is updated, the state may change as well and force indexes to be deleted and reinserted.
###
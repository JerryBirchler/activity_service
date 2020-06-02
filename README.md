###
One of the key features of this service is that it allows the user to insert multiple
composite indexes when adding a request. 

The data field is used to do this. It is a JSON payload with some parts predefined such as:
{
    "indices": [  "comma separated list of fields 1", 
                  "comma separated list of fields 2",
                ...],
    "key field name 1": "value 1",
    "key field name 2": "value 2",
    "key field name 3": ["array value 1", "array value 2", ..]
    "object field" : {
        "key field name 4": "value 4"
        "key field name 5": "value 5"
        "key field name 6": ["array value 1", "array value 2", ..]
    }            
}

each of the above key fields are inventoried into a properties list using a dot notation to convey hierarchy.
Here is a more concrete example:

{
    "indices": [ "entity.type,entity.name,entity.options,state", "state" ],
    "entity": {
        "type": "SqlServer",
        "name": "dfw01sql001",
        "options": ["backup", "shrink", "re-index"]
    }
}

the indioes collection has a comma separated list of entity.type which is "SqlServer", name which is "dfw01sql001" and options which are "backup", "shrink", "re-index". The state field is in the record itself and is a numeric value of 0, 1 or 2. 0 means intiated a request, 1 means recieved a status update, 2 means complete. When adding this request, 4 indexes will be added as follows:

key_name: "entity.type,entity.name,entity.options,state", key_value: "SqlServer,dfw01sql001,backup,0" ...
key_name: "entity.type,entity.name,entity.options,state", key_value: "SqlServer,dfw01sql001,shrink,0" ...
key_name: "entity.type,entity.name,entity.options,state", key_value: "SqlServer,dfw01sql001,re-index,0" ...
key_name: "state", key_value: ",0" ...

all four of these also include the created date and the request uuid where the created date is clustered in descending order.

these indexes are optimized to look for initiated requests. When a request is updated, the state may change as well and force indexes to be deleted and reinserted.
###
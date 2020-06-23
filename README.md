# Activity Service: a customizable, scalable, generic solution for tracking asynchronous calls from start to finish

## Target platform and audience

This project is entirely written in JavaScript and runs on nodejs. It uses Cassandra as its database. It is intended to run in a Docker image for simplicity, but could of course be run as a stand alone service. The design is meant to handle extreme concurrency and failover. It should be possible to run this on any windows, linux or unix platform. 

## How is it customizable yet generic?

The model for tracking a request is based on the components of an HTTP(S) request. This includes simple data like the HTTP method, url, headers and body. The key concept is that some wrapper API will communicate as a proxy between the asynchronous API calls and this service. That wrapper will supply a tracking UUID and obtain a task_id from the asychronous API call response and then call this service to create a request for tracking. The "display_message" field is meant to provide the wrapper a means to convey a user friendly status, and the "data" field is meant to hold any metadata useful to the application. This is where the customization comes into play. The "data" field is assumed to be in JSON format. It contains at least two of four predefined properties. These are: 
<pre>
    "indices": an array of strings containing comma separated property names that combine to define a composite index 
    "foreignKeys": similar in nature to indices 
    "lastUpdated": the API updates this if it is not supplied on any PUT or PATCH request API calls.
    "current": This is updated to true on insert and to false any time a newer request is made for the same entity. This property helps to create a composite index that supports the current view of requests made for all entities.
</pre>    

Any other JSON properties supplied are merged into subsequent updates on a request record. It is entirely up to the application to decide on how to index data using the indices property in combination with any other properties supplied. The POST API even supports an array of indexes. This pattern actually mulitplies the number of indexes for each array supplied. 

## Dynamic indexing on request objects
One of the key features of this service is that it allows the user to insert multiple
composite indexes when adding a request. 

The code behind the API call translates each of the fields into a properties list using a dot notation to convey hierarchy.
Here is a concrete example of a "data" field in JSON:
<pre>
{
    "indices": [ 
        "entity.application,entity.type,entity.name,current", 
        "entity.application,entity.type,entity.name,state", 
        "state" 
    ],
    "entity": {
        "application": "Demo",
        "type": "SqlServer",
        "name": "dfw01sql001"
    },
    "task": {
        "type": "maintenance",
        "actions": ["backup", "shrink", "re-index"]
    },
    "current": true
}
</pre>

And, here is the "properties" list that is internally generated that matches the above data
<pre>
{
    indices: [
        "entity.application,entity.type,entity.name,current", 
        "entity.application,entity.type,entity.name,state", 
        "state" 
    ],
    entity.application: "Demo",
    entity.type: "SqlServer",
    entity.name: "dfw01sql001",
    task.type: "maintenance",
    task.actions: ["backup", "shrink", "re-index"],
    current: true
}
</pre>

This properties list is used internally to merge JSON data across requests on PUT and PATCH API calls.

The indices collection is a reserved property. It contains an array list of indices. Each index is comprised of a single string of comma separated values (with no white space) that map to the properties used to construct a composite index. In this particular case, we have a comma separated list of "entity.application" which is "Demo", "entity.type" which is "SqlServer", and "entity.name" which is "dfw01sql001". The state field is in the record itself and is a numeric value of 0, 1 or 2. 0 means intiated a request, 1 means recieved a status update, 2 means complete. The intent of state is to keep it that simple for a reason. I you were to examine the clustering index on the request_index table, it becomes clear that introducing more granular state might present some problems querying for requests. The underlying assumption is that the state of any given request for a particular entity (or however you might classify what it is you plan to track) should be in one and only one state. It is further assumed that at this level one and only one request can be in any other status than complete.

To summarize "state" values:
<pre>
    0: a request has been intiated
    1: status has been recieved and the request is still in progress
    2: the request has completed
</pre>

When adding this request, 3 indexes will be added as follows:
<pre>
key_name: "entity.application,entity.type,entity.name,current", key_value: "Demo\u0000SqlServer\u0000dfw01sql001\u0000" ...
key_name: "entity.application,entity.type,entity.name,state", key_value: "Demo\u0000SqlServer\u0000dfw01sql001\u00000\u0000" ...
key_name: "state", key_value: "0\u0000" ...
</pre>

All four of these also include the created date and the request uuid where the created date is clustered in descending order.

Fields in the composite index are delimited by a back-slash u ('\u') JavaScript styled hex zero character. This virtually eliminates any possible collisions from other indices. It also means that it is very difficult to use a simple CQL editor to get at this data. However, it does not mean that each property in the composite index operates separately in a query using a greater than or greater or equal operator. This something we will dive more into later. But, essentially you can drive behavior by supplying a level number to a GT or GE operator which will determine at what property level you can limit results to what is supplied for a given property value. 

Here in an example GET by index API call:
<pre>
http://localhost:8081/activity-service/v1/request?entity.application=Demo&entity.type=Oracle&entity.name=dfw01ora&state&operator=GE0
</pre>

This instructs the query to find any on any part of the index that is greater than or equal to the query string values supplied. In this case there are 4 parts to the index. So, level 0 means that no value supplied for any part limits selected results. In this case, the query produces the following results:
<pre>
[
    {
        "uuid": "927d5ab0-a5d0-11ea-bb37-0242ac130002",
        "body": "body",
        "created": "2020-06-03T19:30:24.463Z",
        "data": "{ \"indices\": [ \"entity.type,entity.name,entity.options,state\", \"state\" ], \"entity\": {    \"type\": \"SqlServer\",\"name\": \"dfw01sql003\", \"options\": [\"backup\", \"shrink\", \"re-index\"] } }",
        "display_message": "",
        "headers": "{}",
        "method": "POST",
        "state": 0,
        "task_id": "a05ae67a-a5d0-11ea-bb37-0242ac130002",
        "url": "https//www.google.com"
    },
    {
        "uuid": "1a268248-a5d1-11ea-bb37-0242ac130002",
        "body": "body",
        "created": "2020-06-03T19:34:21.569Z",
        "data": "{ \"indices\": [ \"entity.type,entity.name,entity.options,state\", \"state\" ], \"entity\": {    \"type\": \"Oracle\",\"name\": \"dfw01oral001\", \"options\": [\"backup\", \"shrink\", \"re-index\"] } }",
        "display_message": "",
        "headers": "{}",
        "method": "POST",
        "state": 0,
        "task_id": "257d950a-a5d1-11ea-bb37-0242ac130002",
        "url": "https//www.google.com"
    },
    {
        "uuid": "3f1deb90-a5d1-11ea-bb37-0242ac130002",
        "body": "body",
        "created": "2020-06-03T19:35:06.651Z",
        "data": "{ \"indices\": [ \"entity.type,entity.name,entity.options,state\", \"state\" ], \"entity\": {    \"type\": \"Oracle\",\"name\": \"dfw01oral002\", \"options\": [\"backup\", \"shrink\", \"re-index\"] } }",
        "display_message": "",
        "headers": "{}",
        "method": "POST",
        "state": 0,
        "task_id": "46b3011a-a5d1-11ea-bb37-0242ac130002",
        "url": "https//www.google.com"
    },
    {
        "uuid": "5e8edb24-a5d1-11ea-bb37-0242ac130002",
        "body": "body",
        "created": "2020-06-03T19:35:54.464Z",
        "data": "{ \"indices\": [ \"entity.type,entity.name,entity.options,state\", \"state\" ], \"entity\": {    \"type\": \"Oracle\",\"name\": \"dfw01oral003\", \"options\": [\"backup\", \"shrink\", \"re-index\"] } }",
        "display_message": "",
        "headers": "{}",
        "method": "POST",
        "state": 0,
        "task_id": "65df3496-a5d1-11ea-bb37-0242ac130002",
        "url": "https//www.google.com"
    },
    {
        "uuid": "362fceb5-09fe-44c4-b72e-180451483eca",
        "body": "body",
        "created": "2020-06-03T19:29:35.053Z",
        "data": "{ \"indices\": [ \"entity.type,entity.name,entity.options,state\", \"state\" ], \"entity\": {    \"type\": \"SqlServer\",\"name\": \"dfw01sql002\", \"options\": [\"backup\", \"shrink\", \"re-index\"] } }",
        "display_message": "",
        "headers": "{}",
        "method": "POST",
        "state": 0,
        "task_id": "362fceb5-09fe-44c4-b72e-180451483eca",
        "url": "https//www.google.com"
    },
    {
        "uuid": "a4ebbfeb-20db-44b6-89ad-a8bdca5a1e44",
        "body": "body",
        "created": "2020-06-03T19:21:33.445Z",
        "data": "{ \"indices\": [ \"entity.type,entity.name,entity.options,state\", \"state\" ], \"entity\": {    \"type\": \"SqlServer\",\"name\": \"dfw01sql001\", \"options\": [\"backup\", \"shrink\", \"re-index\"] } }",
        "display_message": "",
        "headers": "{}",
        "method": "POST",
        "state": 0,
        "task_id": "8eeb3b54-a37a-11ea-bb37-0242ac130002",
        "url": "https//www.google.com"
    }
]</pre>

Similarly:
<pre>
http://localhost:8081/activity-service/v1/request?entity.type=MySql&entity.name&entity.options&state&operator=GE1
</pre>

Produces results limited to the entity.type="MySql":
<pre>
[
    {
        "uuid": "54e0640e-a69d-11ea-bb37-0242ac130002",
        "body": "body",
        "created": "2020-06-04T19:56:29.895Z",
        "data": "{\"indices\":[\"entity.application,entity.type,entity.name,current\", \"entity.application,entity.type,entity.name,state\",\"state\"],\"entity\":{\"type\":\"MySql\",\"name\":\"dfw01mysl001\",\"task\":{\"type\":\"maintenance\",\"actions\":[\"backup\"]}}",
        "display_message": "",
        "headers": "{}",
        "method": "POST",
        "state": 0,
        "task_id": "60543004-a69d-11ea-bb37-0242ac130002",
        "url": "https//www.google.com"
    },
    {
        "uuid": "8e1b30a0-a69d-11ea-bb37-0242ac130002",
        "body": "",
        "created": "2020-06-05T16:05:41.617Z",
        "data": "{\"indices\":[\"entity.application,entity.type,entity.name,current\", \"entity.application,entity.type,entity.name,state\",\"state\"],\"entity\":{\"type\":\"MySql\",\"name\":\"dfw01mysl002\",\"task\":{\"type\":\"maintenance\",\"actions\":[\"backup\"]}},\"foreignKeys\":[\"response_uuid\"],\"response_uuid\":\"38872e8e-a74a-11ea-bb37-0242ac130002\",\"lastUpdated\":\"2020-06-05T18:36:57.258Z\"}",
        "display_message": "Backup is 10% complete",
        "headers": "{}",
        "method": "POST",
        "state": 1,
        "task_id": "9424006c-a69d-11ea-bb37-0242ac130002",
        "url": "https//www.google.com"
    }
]</pre>
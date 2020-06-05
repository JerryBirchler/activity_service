# Activity Service: a customizable, scalable, generic solution for tracking asynchronous calls from start to finish

## Target platform and audience

This project is entirely written in JavaScript and runs on nodejs. It uses Cassandra as its database. It is intended to run in a Docker image for simplicity, but could of course be run as a stand alone service. The design is meant to handle extreme concurrency and failover, so there is every possibility this could be run as a clustered solution. It should be therefore possible to run this on any windows, linux or unix platform. 

## How it customizable yet generic?

The model for tracking a request is based on the components of an HTTP(S) request. This includes simple data like the HTTP method, url, headers and body. The key concept is that some wrapper API will communicate as a proxy between the asynchronous API calls and this service. That wrapper will supply a tracking UUID and obtain a task_id from the asychronous API call response and then call this service to create a request for tracking. The "display_message" field is meant to provide the wrapper a means to convey a user friendly status, and the "data" field is meant to hold any metadata useful to the application. This is where the customization comes into play. The "data" field is assumed to be in JSON format. It contains at least three predefined properties. These are: 
<pre>
    "indices": an array of strings containing comma separated property names that combine to define a composite index 
    "foreignKeys": similar in nature to indices 
    "lastUpdated": the API updates this if it is not suipplied on any PUT request API calls.
</pre>    

Any other JSON properties supplied are merged into subsequent updates on a request record. It is entirely upto the application to decide on how to index data using the indices property in combination with any other properties supplied. The POST API even supports an array of indexes. This pattern actually mulitplies the number of indexes for each array supplied. 

## Dynamic indexing on request objects
One of the key features of this service is that it allows the user to insert multiple
composite indexes when adding a request. 

The code behind the API call translates each of the fields into a properties list using a dot notation to convey hierarchy.
Here is a concrete example of a "data" field in JSON:
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

Here the properties list looks like this:
<pre>
{
    indices: ["entity.type,entity.name,entity.options,state", "state"],
    entity.type: "SqlServer",
    entity.name: "dfw01sql001",
    entity.options: ["backup", "shrink", "re-index"]
}
</pre>

The indices collection is a reserved property. It contains an array list of indices. Each index is comprised of a single string of comma separated values (with no white space) that map to the properties used to construct a composite index. In this particular case, we have a comma separated list of "entity.type" which is "SqlServer", "entity.name" which is "dfw01sql001" and "entity.options" which are "backup", "shrink", and "re-index". The state field is in the record itself and is a numeric value of 0, 1 or 2. 0 means intiated a request, 1 means recieved a status update, 2 means complete. The intent of state is to keep it that simple for a reason. I you were to examine the clustering index on the request_index table, it becomes clear that introducing more granular state might present some problems querying for requests. The underlying assumption is that the state of any given request for a particular entity (or however you might classify what it is you plan to track) should be in one and only one state. It is further assumed that at this level one and only one request can be in any other status than complete.

to summarize state values:
 0: a request has been intiated
 1: status has been recieved and the request is still in progress
 2: the request has completed



When adding this request, 4 indexes will be added as follows:

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
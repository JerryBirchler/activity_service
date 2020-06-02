'use strinct';
module.exports = {
    fields: {
        key_name: { type: "varchar" },
        key_value: { type: "varchar" },
        created: { type: "timestamp" },
        uuid: "uuid"
    },
    key: ["key_name", "key_value", "created", "uuid"],
    clustering_order: {"key_value": "asc", "created": "desc", "uuid": "asc"}
};
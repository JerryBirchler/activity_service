'use strinct';
module.exports = {
    fields: {
        uuid: "uuid",
        body: { type: "varchar", default: "" },
        created: { type: "timestamp"},
        data: { type: "varchar", default: "{}" },
        display_message: { type: "varchar", default: "" },
        headers: { type: "varchar", default: "" },
        method: { type: "varchar", default: "POST" },
        state: { type: "int", default: 0 },
        task_id: { type: "varchar", default: "" },
        url: { type: "varchar", default: "" }
    },
    key: ["uuid"]
};
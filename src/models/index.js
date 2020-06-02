const config = require('config'),
      models = require('express-cassandra');

async function init(){
    let db_settings = config.db;
    if (db_settings.auth) {
        db_settings.clientOptions['authProvider'] = new models.driver.auth.PlainTextAuthProvider(db_settings.auth.user, db_settings.auth.password);
    }
    await models.setDirectory(__dirname).bindAsync(db_settings);
}

module.exports = {
    init: init,
    models: models
};
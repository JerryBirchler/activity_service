'use strict';
class TimeoutException extends Error {
    status = 409;
    constructor(id) {
        super(`Timed out waiting for update on: [${id}]`);
    }
};

class MissingRequiredPropertyException extends Error {
    status = 400;

    constructor(key) {
        super(`Required property: [${key}] is missing`);
    }
};

class ReserverdPropertyException extends Error {
    status = 400;
    constructor(key) {
        super(`Reserved property: [${key}] is not allowed`);                          
    }
};

class IncompatibleTypesException extends Error { 
    status = 400;
    constructor() {
        super("Incompatible type merging data JSON");
    }
};

class BreakException extends Error { 
    constructor() {
        super("break");
    }
};    

module.exports = {
    TimeoutException: TimeoutException,
    MissingRequiredPropertyException: MissingRequiredPropertyException,
    ReserverdPropertyException: ReserverdPropertyException,
    IncompatibleTypesException: IncompatibleTypesException,
    BreakException: BreakException
};

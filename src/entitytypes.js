"use strict";

var util            = require('util');
var assert          = require('assert');
var _               = require('lodash');
var debug           = require('debug')('base:entity:types');
var slugid          = require('slugid');
var stringify       = require('json-stable-stringify');
var buffertools     = require('buffertools');
var crypto          = require('crypto');
var azure           = require('fast-azure-storage');
var Ajv             = require('ajv');
var fmt             = azure.Table.Operators;

// Check that value is of types for name and property
// Print messages and throw an error if the check fails
var checkType = function(name, property, value, types) {
  if (!(types instanceof Array)) {
    types = [types];
  }
  if (types.indexOf(typeof(value)) === -1) {
    debug("%s '%s' expected %j got: %j", name, property, types, value);
    throw new Error(name + " '" + property + "' expected one of type(s): '" +
                    types.join(',') + "' got type: '" + typeof(value) + "'");
  }
};

/******************** Base Type ********************/

/** Base class for all Entity serializable data types */
var BaseType = function(property) {
  this.property = property;
};

/**
 * Does elements of this type have an ordering.
 *
 * Decides if the type can be used with comparison operators <, <=, >, >= when
 * doing a table scan or query.
 */
BaseType.prototype.isOrdered    = false;

/**
 * Does elements of this type have a concept of equality.
 *
 * Decides if the typs can be used with equality and in-equality operators when
 * doing a table scan or query.
 */
BaseType.prototype.isComparable = false;

/**
 * Does element of this type encrypt their content
 *
 * If `true` the `cryptoKey` will be given as 3rd and 2nd parameter for
 * `serialize` and `deserialize`, respectively. When given the encryption key
 * is always 32 bytes assumed to already random.
 */
BaseType.prototype.isEncrypted = false;

/**
 * Serialize value to target for property
 *
 * Will serialize `value` to `target` object, given `cryptoKey` if this
 * is an encrypting type (one that has `isEncrypted: true`) the type must
 * encrypted the data with `cryptoKey` before saving it to target.
 */
BaseType.prototype.serialize = function(target, value, cryptoKey) {
  throw new Error("Not implemented");
};

/** Compare the two values (deep comparison if necessary) */
BaseType.prototype.equal = function(value1, value2) {
  // Compare using serialize(), this works because serialize(), must be
  // implemented, but it might not be the cheapest implementation
  var target1 = {},
      target2 = {};
  this.serialize(target1, value1);
  this.serialize(target2, value2);
  return _.isEqual(target1, target2);
};

/** Constructor a fairly deep clone of this item */
BaseType.prototype.clone = function(value) {
  var virtualTarget = {};
  this.serialize(virtualTarget, value);
  return this.deserialize(virtualTarget);
};

/** Construct $filter string with operator */
BaseType.prototype.filterCondition = function(op) {
  throw new Error("Not implemented");
};

/** Apply the filter op in-memory */
BaseType.prototype.compare = function(entity, op) {
  throw new Error("Not implemented");
};

/** Get a string representation for key generation (optional) */
BaseType.prototype.string = function(value) {
  throw new Error("Operation is not support for this data type");
};

/** Get a string or buffer representation for hash-key generation (optional) */
BaseType.prototype.hash = function(value) {
  return this.string(value);
};

/**
 * Deserialize value for property from source
 *
 * If this is an encrypting type (one that has `isEncrypted: true`) the type
 * must decrypted the data with `cryptoKey` before deserializing it.
 */
BaseType.prototype.deserialize = function(source, cryptoKey) {
  throw new Error("Not implemented");
};

// Export BaseType
exports.BaseType = BaseType;

/******************** Value Type ********************/

/** Base class Value Entity types */
var BaseValueType = function(property) {
  BaseType.apply(this, arguments);
};

// Inherit from BaseType
util.inherits(BaseValueType, BaseType);

BaseValueType.prototype.isOrdered    = true;
BaseValueType.prototype.isComparable = true;

/** Validate the type of the value */
BaseValueType.prototype.validate = function(value) {
  throw new Error("Not implemented");
};

BaseValueType.prototype.serialize = function(target, value) {
  this.validate(value);
  target[this.property] = value;
};

BaseValueType.prototype.equal = function(value1, value2) {
  return value1 === value2;
};

BaseValueType.prototype.clone = function(value) {
  return value;
};

BaseValueType.prototype.string = function(value) {
  this.validate(value);
  return value;
};

BaseValueType.prototype.deserialize = function(source) {
  var value = source[this.property];
  this.validate(value);
  return value;
};

// Export BaseValueType
exports.BaseValueType = BaseValueType;

/******************** String Type ********************/

/** String Entity type */
var StringType = function(property) {
  BaseValueType.apply(this, arguments);
};

// Inherit from BaseValueType
util.inherits(StringType, BaseValueType);

StringType.prototype.validate = function(value) {
  checkType('StringType', this.property, value, 'string');
};

StringType.prototype.filterCondition = function(op) {
  this.validate(op.operand);
  return this.property + ' ' + op.operator + ' ' + fmt.string(op.operand);
};

StringType.prototype.compare = function(entity, op) {
  return op.compare(entity[this.property], op.operand);
};

// Export StringType as String
exports.String = StringType;

/******************** Boolean Type ********************/

/** Boolean Entity type */
var BooleanType = function(property) {
  BaseValueType.apply(this, arguments);
};

// Inherit from BaseValueType
util.inherits(BooleanType, BaseValueType);

BooleanType.prototype.isOrdered = false;

BooleanType.prototype.validate = function(value) {
  checkType('BooleanType', this.property, value, 'boolean');
};

BooleanType.prototype.string = function(value) {
  this.validate(value);
  return value.toString();
};

BooleanType.prototype.filterCondition = function(op) {
  this.validate(op.operand);
  return this.property + ' ' + op.operator + ' ' + op.operand.toString();
};

BooleanType.prototype.compare = function(entity, op) {
  return op.compare(entity[this.property], op.operand);
};

// Export BooleanType as Boolean
exports.Boolean = BooleanType;

/******************** Number Type ********************/

/** Number Entity type */
var NumberType = function(property) {
  BaseValueType.apply(this, arguments);
};

// Inherit from BaseValueType
util.inherits(NumberType, BaseValueType);

NumberType.prototype.validate = function(value) {
  checkType('NumberType', this.property, value, 'number');
};

NumberType.prototype.serialize = function(target, value) {
  this.validate(value);
  if (value % 1  === 0 && Math.abs(value) >= 2147483648) {
    target[this.property] = value.toString();
    target[this.property + '@odata.type'] = 'Edm.Int64';
  } else {
    // No type info for Edm.Double or Edm.Int32
    target[this.property] = value;
  }
};

NumberType.prototype.string = function(value) {
  this.validate(value);
  return value.toString();
};

NumberType.prototype.deserialize = function(source) {
  var value = source[this.property];
  if (source[this.property + '@odata.type'] === 'Edm.Int64') {
    value = parseInt(value);
  }
  this.validate(value);
  return value;
};

NumberType.prototype.filterCondition = function(op) {
  this.validate(op.operand);
  return this.property + ' ' + op.operator + ' ' + fmt.number(op.operand);
};

NumberType.prototype.compare = function(entity, op) {
  return op.compare(+entity[this.property], +op.operand);
};


// Export NumberType as Number
exports.Number = NumberType;

/******************** Positive Integer Type ********************/

/** Positive Integer Entity type */
var PositiveIntegerType = function(property) {
  NumberType.apply(this, arguments);
};

// Inherit from NumberType
util.inherits(PositiveIntegerType, NumberType);

PositiveIntegerType.prototype.validate = function(value) {
  checkType('PositiveIntegerType', this.property, value, 'number');
  if (!isNaN(value) && value % 1  !== 0) {
    throw new Error("PositiveIntegerType '" + this.property + "'" +
                    " expected an integer got a float or NaN");
  }
  if (value < 0) {
    throw new Error("PositiveIntegerType '" + this.property + "'" +
                    " expected a positive integer, got less than zero");
  }
  if (value > Math.pow(2, 32)) {
    throw new Error("PositiveIntegerType '" + this.property + "'" +
                    " expected an integer, got more than 2^32");
  }
};

// Export PositiveIntegerType as PositiveInteger
exports.PositiveInteger = PositiveIntegerType;

/******************** Date Type ********************/

/** Date Entity type */
var DateType = function(property) {
  BaseType.apply(this, arguments);
};

// Inherit from BaseType
util.inherits(DateType, BaseType);

DateType.prototype.isOrdered    = true;
DateType.prototype.isComparable = true;

DateType.prototype.validate = function(value) {
  if (!(value instanceof Date)) {
    throw new Error("DateType '" + this.property +
                    "' expected a date got type: " + typeof(value));
  }
};

DateType.prototype.serialize = function(target, value) {
  this.validate(value);
  target[this.property + '@odata.type'] = 'Edm.DateTime';
  target[this.property] = value.toJSON();
};

DateType.prototype.equal = function(value1, value2) {
  this.validate(value1);
  this.validate(value2);
  return value1.getTime() === value2.getTime();
};

DateType.prototype.clone = function(value) {
  this.validate(value);
  return new Date(value);
};

DateType.prototype.string = function(value) {
  this.validate(value);
  return value.toJSON();
};

DateType.prototype.deserialize = function(source) {
  var value = new Date(source[this.property]);
  this.validate(value);
  return value;
};

DateType.prototype.filterCondition = function(op) {
  this.validate(op.operand);
  return this.property + ' ' + op.operator + ' ' + fmt.date(op.operand);
};

DateType.prototype.compare = function(entity, op) {
  return op.compare(new Date(entity[this.property]).getTime(), op.operand.getTime());
};


// Export DateType as Date
exports.Date = DateType;


/******************** UUID Type ********************/

/** UUID Entity type */
var UUIDType = function(property) {
  BaseValueType.apply(this, arguments);
};

// Inherit from BaseValueType
util.inherits(UUIDType, BaseValueType);

UUIDType.prototype.isOrdered    = true;
UUIDType.prototype.isComparable = true;

var _uuidExpr = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

UUIDType.prototype.validate = function(value) {
  checkType('UUIDType', this.property, value, 'string');
  if (!_uuidExpr.test(value)) {
    throw new Error("UUIDType '" + this.property + "' expected a uuid got: "
                    + value);
  }
};

UUIDType.prototype.equal = function(value1, value2) {
  return value1.toLowerCase() === value2.toLowerCase();
};

UUIDType.prototype.string = function(value) {
  return value.toLowerCase();
};

UUIDType.prototype.serialize = function(target, value) {
  this.validate(value);
  target[this.property + '@odata.type'] = 'Edm.Guid';
  target[this.property] = value;
};

UUIDType.prototype.filterCondition = function(op) {
  this.validate(op.operand);
  return this.property + ' ' + op.operator + ' ' + fmt.guid(op.operand);
};

UUIDType.prototype.compare = function(entity, op) {
  throw new Error("Not implemented");
};

// Export UUIDType as UUID
exports.UUID = UUIDType;


/******************** SlugId Type ********************/

/** SlugId Entity type */
var SlugIdType = function(property) {
  BaseValueType.apply(this, arguments);
};

// Inherit from BaseValueType
util.inherits(SlugIdType, BaseValueType);

SlugIdType.prototype.isOrdered    = true;
SlugIdType.prototype.isComparable = true;

var _slugIdExpr = /^[A-Za-z0-9_-]{8}[Q-T][A-Za-z0-9_-][CGKOSWaeimquy26-][A-Za-z0-9_-]{10}[AQgw]$/i;

SlugIdType.prototype.validate = function(value) {
  checkType('SlugIdType', this.property, value, 'string');
  if(!_slugIdExpr.test(value)) {
    throw new Error("SlugIdType '" + this.property +
                    "' expected a slugid got: " + value);
  }
};

SlugIdType.prototype.serialize = function(target, value) {
  this.validate(value);
  target[this.property + '@odata.type'] = 'Edm.Guid';
  target[this.property] = slugid.decode(value);
};

SlugIdType.prototype.deserialize = function(source) {
  return slugid.encode(source[this.property]);
};

SlugIdType.prototype.filterCondition = function(op) {
  this.validate(op.operand);
  return this.property + ' ' + op.operator + ' ' +
    fmt.guid(slugid.encode(op.operand));
};

SlugIdType.prototype.compare = function(entity, op) {
  throw new Error("Not implemented");
};


// Export SlugIdType as SlugId
exports.SlugId = SlugIdType;

/******************** Buffer Type ********************/

/** Abstract type of all buffer based Entity types
 *
 * Subclasses will get `hash`, `serialize` and `deserialize` for free if they
 * implement `toBuffer` and `fromBuffer`.
 */
var BaseBufferType = function(property) {
  BaseType.apply(this, arguments);
};

// Inherit from BaseType
util.inherits(BaseBufferType, BaseType);

BaseBufferType.prototype.isOrdered    = false;
BaseBufferType.prototype.isComparable = false;

/** Transform value to buffer */
BaseBufferType.prototype.toBuffer = function(value, cryptoKey) {
  throw new Error("Not implemented");
};

/** Transform value from buffer */
BaseBufferType.prototype.fromBuffer = function(buffer, cryptoKey) {
  throw new Error("Not implemented");
};

BaseBufferType.prototype.serialize = function(target, value, cryptoKey) {
  value = this.toBuffer(value, cryptoKey);
  assert(value.length <= 256 * 1024, "Can't store buffers > 256kb");
  // We have one chunk per 64kb
  var chunks = Math.ceil(value.length / (64 * 1024));
  for(var i = 0; i < chunks; i++) {
    var end   = Math.min((i + 1) * 64 * 1024, value.length);
    var chunk = value.slice(i * 64 * 1024, end);
    target['__buf' + i + '_' + this.property + '@odata.type'] = 'Edm.Binary';
    target['__buf' + i + '_' + this.property] = chunk.toString('base64');
  }
  target['__bufchunks_' + this.property] = chunks;
};

BaseBufferType.prototype.hash = function(value) {
  return this.toBuffer(value);
};

BaseBufferType.prototype.deserialize = function(source, cryptoKey) {
  var n = source['__bufchunks_' + this.property];
  checkType('BaseBufferType', '__bufchunks_' + this.property, n, 'number');

  var chunks = [];
  for(var i = 0; i < n; i++) {
    chunks[i] = new Buffer(source['__buf' + i + '_' + this.property], 'base64');
  }
  return this.fromBuffer(Buffer.concat(chunks), cryptoKey);
};

BaseBufferType.prototype.filterCondition = function(op) {
  throw new Error("Buffer based types are not comparable!");
};

SlugIdType.prototype.compare = function(entity, op) {
  throw new Error("Buffer based types are not comparable!");
};


// Export BaseBufferType as BaseBufferType
exports.BaseBufferType = BaseBufferType;

/******************** Blob Type ********************/

/** Blob Entity type */
var BlobType = function(property) {
  BaseBufferType.apply(this, arguments);
};

// Inherit from BaseBufferType
util.inherits(BlobType, BaseBufferType);

BlobType.prototype.validate = function(value) {
  assert(Buffer.isBuffer(value),
         "BlobType '" + this.property + "' expected a Buffer");
};

BlobType.prototype.toBuffer = function(value) {
  this.validate(value);
  return value;
};

BlobType.prototype.fromBuffer = function(value) {
  this.validate(value);
  return value;
};

BlobType.prototype.equal = function(value1, value2) {
  this.validate(value1);
  this.validate(value2);
  if (value1 === value2) {
    return true;
  }
  if (value1.length !== value2.length) {
    return false;
  }
  return buffertools.compare(value1, value2) === 0;
};

BlobType.prototype.clone = function(value) {
  this.validate(value);
  return new Buffer(value);
};

// Export BlobType as Blob
exports.Blob = BlobType;

/******************** Text Type ********************/

/** Text Entity type */
var TextType = function(property) {
  BaseBufferType.apply(this, arguments);
};

// Inherit from BaseBufferType
util.inherits(TextType, BaseBufferType);

TextType.prototype.validate = function(value) {
  checkType('TextType', this.property, value, 'string');
};

TextType.prototype.toBuffer = function(value) {
  this.validate(value);
  return new Buffer(value, 'utf8');
};

TextType.prototype.fromBuffer = function(value) {
  return value.toString('utf8');
};

TextType.prototype.equal = function(value1, value2) {
  return value1 === value2;
};

TextType.prototype.hash = function(value) {
  return value;
};

TextType.prototype.clone = function(value) {
  return value;
};

// Export TextType as Text
exports.Text = TextType;

/******************** JSON Type ********************/

/** JSON Entity type */
var JSONType = function(property) {
  BaseBufferType.apply(this, arguments);
};

// Inherit from BaseBufferType
util.inherits(JSONType, BaseBufferType);

JSONType.prototype.validate = function(value) {
  checkType('JSONType', this.property, value, [
    'string',
    'number',
    'object',
    'boolean'
  ]);
};

JSONType.prototype.toBuffer = function(value) {
  this.validate(value);
  return new Buffer(JSON.stringify(value), 'utf8');
};

JSONType.prototype.fromBuffer = function(value) {
  return JSON.parse(value.toString('utf8'));
};

JSONType.prototype.equal = function(value1, value2) {
  return _.isEqual(value1, value2);
};

JSONType.prototype.hash = function(value) {
  return stringify(value);
};

JSONType.prototype.clone = function(value) {
  return _.cloneDeep(value);
};

// Export JSONType as JSON
exports.JSON = JSONType;

/******************** Schema Type ********************/

// Export SchemaEnforcedType as Schema
exports.Schema = function(schema) {
  let ajv = new Ajv({useDefaults: true});
  let validate = ajv.compile(schema);

  /** Schema Entity type */
  var SchemaEnforcedType = function(property) {
    JSONType.apply(this, arguments);
  };

  // Inherit from JSONType
  util.inherits(SchemaEnforcedType, JSONType);

  SchemaEnforcedType.prototype.validate = function(value) {
    if (validate(value)) {
      return;
    }
    let err = new Error(
      "SchemaEnforcedType '" + this.property +
      "' schema validation failed: " + ajv.errorsText(validate.errors)
    );
    err.errors = validate.errors;
    err.value = value;
    throw err;
  };

  return SchemaEnforcedType;
};

/******************** Encrypted Base Type ********************/

/** Encrypted Base Entity type */
var EncryptedBaseType = function(property) {
  BaseBufferType.apply(this, arguments);
};

// Inherit from BaseBufferType
util.inherits(EncryptedBaseType, BaseBufferType);

// This type is encrypted an will need the encryption key
EncryptedBaseType.prototype.isEncrypted = true;

/** Transform value to buffer */
EncryptedBaseType.prototype.toPlainBuffer = function(value) {
  throw new Error("Not implemented");
};

/** Transform value from buffer */
EncryptedBaseType.prototype.fromPlainBuffer = function(buffer) {
  throw new Error("Not implemented");
};

EncryptedBaseType.prototype.toBuffer = function(value, cryptoKey) {
  var plainBuffer = this.toPlainBuffer(value);
  // Need room for initialization vector and any padding
  assert(plainBuffer.length <= 256 * 1024 - 32,
         "Can't store buffers > 256 * 1024 - 32 bytes");
  var iv          = crypto.randomBytes(16);
  var cipher      = crypto.createCipheriv('aes-256-cbc', cryptoKey, iv);
  var c1          = cipher.update(plainBuffer);
  var c2          = cipher.final();
  return Buffer.concat([iv, c1, c2]);
};

EncryptedBaseType.prototype.fromBuffer = function(buffer, cryptoKey) {
  var iv          = buffer.slice(0, 16);
  var decipher    = crypto.createDecipheriv('aes-256-cbc', cryptoKey, iv);
  var b1          = decipher.update(buffer.slice(16));
  var b2          = decipher.final();
  return this.fromPlainBuffer(Buffer.concat([b1, b2]));
};

EncryptedBaseType.prototype.hash = function(value) {
  return this.toPlainBuffer(value);
};

/******************** Encrypted Blob Type ********************/

/** Encrypted Blob Entity type */
var EncryptedBlobType = function(property) {
  EncryptedBaseType.apply(this, arguments);
};

// Inherit from EncryptedBaseType
util.inherits(EncryptedBlobType, EncryptedBaseType);

EncryptedBlobType.prototype.validate = function(value) {
  assert(Buffer.isBuffer(value),
         "EncryptedBlobType '" + this.property + "' expected a Buffer");
};

EncryptedBlobType.prototype.toPlainBuffer = function(value) {
  this.validate(value);
  return value;
};

EncryptedBlobType.prototype.fromPlainBuffer = function(value) {
  this.validate(value);
  return value;
};

EncryptedBlobType.prototype.equal = function(value1, value2) {
  this.validate(value1);
  this.validate(value2);
  if (value1 === value2) {
    return true;
  }
  if (value1.length !== value2.length) {
    return false;
  }
  return buffertools.compare(value1, value2) === 0;
};

EncryptedBlobType.prototype.clone = function(value) {
  this.validate(value);
  return new Buffer(value);
};

// Export EncryptedBlobType as EncryptedBlob
exports.EncryptedBlob = EncryptedBlobType;

/******************** Encrypted Text Type ********************/

/** Encrypted Text Entity type */
var EncryptedTextType = function(property) {
  EncryptedBaseType.apply(this, arguments);
};

// Inherit from EncryptedBaseType
util.inherits(EncryptedTextType, EncryptedBaseType);

EncryptedTextType.prototype.validate = function(value) {
  checkType('EncryptedTextType', this.property, value, 'string');
};

EncryptedTextType.prototype.toPlainBuffer = function(value) {
  this.validate(value);
  return new Buffer(value, 'utf8');
};

EncryptedTextType.prototype.fromPlainBuffer = function(value) {
  return value.toString('utf8');
};

EncryptedTextType.prototype.equal = function(value1, value2) {
  return value1 === value2;
};

EncryptedTextType.prototype.hash = function(value) {
  return value;
};

EncryptedTextType.prototype.clone = function(value) {
  return value;
};

// Export EncryptedTextType as Text
exports.EncryptedText = EncryptedTextType;

/******************** Encrypted JSON Type ********************/

/** Encrypted JSON Entity type */
var EncryptedJSONType = function(property) {
  EncryptedBaseType.apply(this, arguments);
};

// Inherit from EncryptedBaseType
util.inherits(EncryptedJSONType, EncryptedBaseType);

EncryptedJSONType.prototype.validate = function(value) {
  checkType('EncryptedJSONType', this.property, value, [
    'string',
    'number',
    'object',
    'boolean'
  ]);
};

EncryptedJSONType.prototype.toPlainBuffer = function(value) {
  this.validate(value);
  return new Buffer(JSON.stringify(value), 'utf8');
};

EncryptedJSONType.prototype.fromPlainBuffer = function(value) {
  return JSON.parse(value.toString('utf8'));
};

EncryptedJSONType.prototype.equal = function(value1, value2) {
  return _.isEqual(value1, value2);
};

EncryptedJSONType.prototype.hash = function(value) {
  return stringify(value);
};

EncryptedJSONType.prototype.clone = function(value) {
  return _.cloneDeep(value);
};

// Export EncryptedJSONType as EncryptedJSON
exports.EncryptedJSON = EncryptedJSONType;

/******************** EncryptedSchema Type ********************/

// Export EncryptedSchemaEnforcedType as EncryptedSchema
exports.EncryptedSchema = function(schema) {
  let ajv = new Ajv({useDefaults: true});
  let validate = ajv.compile(schema);

  /** Schema Entity type */
  var EncryptedSchemaEnforcedType = function(property) {
    EncryptedJSONType.apply(this, arguments);
  };

  // Inherit from EncryptedJSONType
  util.inherits(EncryptedSchemaEnforcedType, EncryptedJSONType);

  EncryptedSchemaEnforcedType.prototype.validate = function(value) {
    if (validate(value)) {
      return;
    }
    let err = new Error(
      "EncryptedSchemaEnforcedType '" + this.property +
      "' schema validation failed: " + ajv.errorsText(validate.errors)
    );
    err.errors = validate.errors;
    err.value = value;
    throw err;
  };

  return EncryptedSchemaEnforcedType;
};

/******************** SlugIdArray Type ********************/

// SIZE of a slugid
var SLUGID_SIZE = 128 / 8;

// Convert slugid to buffer
var slugIdToBuffer = function(slug) {
  var base64 = slug
                  .replace(/-/g, '+')
                  .replace(/_/g, '/')
                  + '==';
  return new Buffer(base64, 'base64');
};

// Convert buffer to slugId where `entryIndex` is the slugId entry index to retrieve
var bufferToSlugId = function (bufferView, entryIndex) {
  return bufferView.toString('base64', entryIndex * SLUGID_SIZE, SLUGID_SIZE * (entryIndex + 1))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/==/g, '');
};

/** Array of slugids packed into a buffer for space and speed */
var SlugIdArray = function() {
  this.buffer = new Buffer(SLUGID_SIZE * 32);
  this.length = 0;
  this.avail  = 32;
};

/** Retrieve all the entries added to the buffer in their original format i.e., before being turned into base64 slugIds */
SlugIdArray.prototype.toArray = function() {
  const buffer = this.getBufferView();
  let result = [];

  for (let i = 0; i < this.length; i++) {
    const slug = bufferToSlugId(buffer, i);

    result.push(slug);
  }

  return result;
};

/** Added slugid to end of the array */
SlugIdArray.prototype.push = function(slug) {
  this.realloc();
  slugIdToBuffer(slug).copy(this.buffer, this.length * SLUGID_SIZE);
  this.length += 1;
  this.avail  -= 1;
};

/** Allocate more space if needed, and less space if below threshold */
SlugIdArray.prototype.realloc = function() {
  if (this.avail === 0 && this.length === 0) {
    this.buffer = new Buffer(SLUGID_SIZE * 32);
    this.length = 0;
    this.avail = 32;

    return true;
  }

  // Allocate more space, if needed, we this by doubling the underlying buffer
  if (this.avail === 0) {
    var buffer = new Buffer(this.length * 2 * SLUGID_SIZE);
    this.buffer.copy(buffer);
    this.buffer = buffer;
    this.avail = this.length;
    return true;
  }

  // Shrink the buffer if it is less than 1/3 full
  if (this.avail > this.length * 2 && this.buffer.length > SLUGID_SIZE * 32) {
    this.buffer = new Buffer(this.getBufferView());
    this.avail  = 0;
    return true;
  }
  return false;
};

/** Get indexOf of a slugid, -1 if it is not in the array */
SlugIdArray.prototype.indexOf = function(slug) {
  var slug  = slugIdToBuffer(slug);
  var index = buffertools.indexOf(this.buffer, slug);

  while (index !== -1 && index < this.length * SLUGID_SIZE) {
    if (index % SLUGID_SIZE === 0) {
      return index / SLUGID_SIZE;
    }
    index = buffertools.indexOf(this.buffer, slug, index + 1);
  }
  return -1;
};

/** Determines whether it includes a certain element, returning true or false as appropriate. */
SlugIdArray.prototype.includes = function(slug) {
  return this.indexOf(slug) !== -1 ? true : false;
};

/**
 * The shift() method removes the first element. Each operation will take a
 * time proportional to the number of the array length */
SlugIdArray.prototype.shift = function() {
  if (this.length === 0) {
    return;
  }

  const result = bufferToSlugId(this.buffer, 0);

  this.buffer.copy(this.buffer, 0, SLUGID_SIZE);

  this.avail  += 1;
  this.length -= 1;
  this.realloc();

  return result;
};

/** The pop() method removes the last element. */
SlugIdArray.prototype.pop = function() {
  if (this.length === 0) {
    return;
  }

  const result = bufferToSlugId(this.buffer, this.length - 1);

  this.avail  += 1;
  this.length -= 1;
  this.realloc();

  return result;
};

/** Remove slugid from array */
SlugIdArray.prototype.remove = function(slug) {
  var index = this.indexOf(slug);
  if (index > -1) {
    // This uses memmove, so my cowboy tricks are okay, - I hope :)
    this.buffer.copy(
      this.buffer,
      index * SLUGID_SIZE,
      (index + 1) * SLUGID_SIZE
    );
    this.avail  += 1;
    this.length -= 1;
    this.realloc();
    return true;
  }
  return false;
};

/**
 * The slice() method returns a copy of a portion of an array
 * into a new array object, selected from begin to end (end not included).
 * The original array will not be modified.
 */
SlugIdArray.prototype.slice = function(begin, end) {
  if (begin < 0) {
    begin = this.length + begin;
  } else {
    begin = begin || 0;
  }

  if (end < 0) {
    end = this.length + end;
  } else {
    end = (!end || this.length > end) ? this.length : end;
  }

  // Return a copy of the array
  const count = end - begin;
  const buffer = this.buffer.slice(begin * SLUGID_SIZE, end * SLUGID_SIZE);
  let result = [];

  for (let i = 0; i < count; i++) {
    result.push(bufferToSlugId(buffer, i));
  }

  return result;
};

/** Clone the slugid array */
SlugIdArray.prototype.clone = function() {
  var clone = new SlugIdArray();
  clone.buffer  = new Buffer(this.buffer);
  clone.length  = this.length;
  clone.avail   = this.avail;
  return clone;
};

/** Compare slugid arrays */
SlugIdArray.prototype.equals = function(other) {
  assert(other instanceof SlugIdArray, "Expected a SlugIdArray");
  return buffertools.compare(
    this.getBufferView(),
    other.getBufferView()
  ) === 0;
};


/**
 * Get a buffer view for the internal structure, only use this for reading,
 * and note that the value is undefined when the SlugIdArray is modified again.
 */
SlugIdArray.prototype.getBufferView = function() {
  return this.buffer.slice(0, this.length * SLUGID_SIZE);
};

SlugIdArray.fromBuffer = function(buffer) {
  var array = new SlugIdArray();
  array.buffer  = buffer;
  array.length  = buffer.length / SLUGID_SIZE;
  array.avail   = 0;
  return array;
};

/** SlugIdArray Entity type */
var SlugIdArrayType = function(property) {
  BaseBufferType.apply(this, arguments);
};

// Inherit from BaseBufferType
util.inherits(SlugIdArrayType, BaseBufferType);

SlugIdArrayType.prototype.toBuffer = function(value) {
  assert(value instanceof SlugIdArray, "SlugIdArrayType '" + this.property +
         "' expected SlugIdArray, got: " + value);
  return value.getBufferView();
};

SlugIdArrayType.prototype.fromBuffer = function(value) {
  return SlugIdArray.fromBuffer(value);
};

SlugIdArrayType.prototype.equal = function(value1, value2) {
  assert(value1 instanceof SlugIdArray, "SlugIdArrayType '" + this.property +
         "' expected SlugIdArray, got: " + value1);
  assert(value2 instanceof SlugIdArray, "SlugIdArrayType '" + this.property +
         "' expected SlugIdArray, got: " + value2);
  return value1.equals(value2);
};

SlugIdArrayType.prototype.hash = function(value) {
  assert(value instanceof SlugIdArray, "SlugIdArrayType '" + this.property +
         "' expected SlugIdArray, got: " + value);
  return value.getBufferView();
};

SlugIdArrayType.prototype.clone = function(value) {
  assert(value instanceof SlugIdArray, "SlugIdArrayType '" + this.property +
         "' expected SlugIdArray, got: " + value);
  return value.clone();
};

/** Create an empty SlugIdArray */
SlugIdArrayType.create = function() {
  return new SlugIdArray();
};

// Export SlugIdArrayType as SlugIdArray
exports.SlugIdArray = SlugIdArrayType;

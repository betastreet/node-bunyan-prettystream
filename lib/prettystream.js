"use strict";

var Stream = require('stream').Stream;
var util = require('util');
var format = util.format;
var http = require('http');

var colors = {
  'bold' : [1, 22],
  'italic' : [3, 23],
  'underline' : [4, 24],
  'inverse' : [7, 27],
  'white' : [37, 39],
  'grey' : [90, 39],
  'black' : [30, 39],
  'blue' : [34, 39],
  'cyan' : [36, 39],
  'green' : [32, 39],
  'magenta' : [35, 39],
  'red' : [31, 39],
  'yellow' : [33, 39]
};

var defaultOptions = {
  mode: 'long', //short, long, dev, none
  useColor: 'auto' // true, false, 'auto' (true if output is a TTY)
};

var levelFromName = {
  'trace': 10,
  'debug': 20,
  'info': 30,
  'warn': 40,
  'error': 50,
  'fatal': 60
};

var colorFromLevel = {
  10: 'grey',     // TRACE
  20: 'grey',     // DEBUG
  30: 'cyan',     // INFO
  40: 'magenta',  // WARN
  50: 'red',      // ERROR
  60: 'inverse'  // FATAL
};

var nameFromLevel = {};
var upperNameFromLevel = {};
var upperPaddedNameFromLevel = {};
Object.keys(levelFromName).forEach(function (name) {
  var lvl = levelFromName[name];
  nameFromLevel[lvl] = name;
  upperNameFromLevel[lvl] = name.toUpperCase();
  upperPaddedNameFromLevel[lvl] = (name.length === 4 ? ' ' : '') + name.toUpperCase();
});

//---- Internal support stuff

// http://stackoverflow.com/questions/4816099/chrome-sendrequest-error-typeerror-converting-circular-structure-to-json
var censor = function(censor) {
  return (function() {
    var keyList, valueOrderedSet;
    keyList = [];
    valueOrderedSet = [];
    return function(key, value) {
      var index;
      index = valueOrderedSet.indexOf(value);
      // if value is object and not found in valueOrderedSet
      if (typeof value === 'object' && index > -1) {
        // Note: null can also be circular!
        if (value === null ){
          return 'null';
        }
        return '[Circular] ' + keyList[index];
      }
      keyList.push(key);
      valueOrderedSet.push(value);
      return value;
    }
  })(censor);
};

var JSON_stringify = function(/*obj, fn, format*/) {
  var args = [].slice.call(arguments)

  args[1] = censor(args[0])
  return JSON.stringify.apply(null, args);
};

function PrettyStream(opts){
  var self = this, options = {};

  if (opts){
    Object.keys(opts).forEach(function(key){
      options[key] = {
        value: opts[key],
        enumerable: true,
        writable: true,
        configurable: true
      };
    });
  }

  var config = Object.create(defaultOptions, options);

  this.readable = true;
  this.writable = true;
  this.isTTY = false;

  Stream.call(this);

  function stylize(str, color) {
    if (!str){
      return '';
    }

    if (config.useColor === false ||
        (config.useColor === 'auto' && !self.isTTY)) {
      return str;
    }

    if (!color){
      color = 'white';
    }

    var codes = colors[color];
    if (codes) {
      return '\x1B[' + codes[0] + 'm' + str +
             '\x1B[' + codes[1] + 'm';
    }
    return str;
  }

  function indent(s) {
    return '    ' + s.split(/\r?\n/).join('\n    ');
  }

  function extractTime(rec){
    var time = (typeof rec.time === 'object') ? rec.time.toISOString() : rec.time;

    if ((config.mode === 'short' || config.mode === 'dev') && time[10] == 'T') {
      return stylize(time.substr(11));
    }
    return stylize(time);
  }

  function extractName(rec){
    var name =  rec.name;

    if (rec.component) {
      name += '/' + rec.component;
    }

    if (config.mode !== 'short' && config.mode !== 'dev'){
      name += '/' + rec.pid;
    }

    return name;
  }

  function extractLevel(rec){
    var level = (upperPaddedNameFromLevel[rec.level] || 'LVL' + rec.level);
    return stylize(level, colorFromLevel[rec.level]);
  }

  function extractSrc(rec){
    var src = '';
    if (rec.src && rec.src.file) {
      if (rec.src.func) {
        src = format('(%s:%d in %s)', rec.src.file, rec.src.line, rec.src.func);
      } else {
        src = format('(%s:%d)', rec.src.file, rec.src.line);
      }
    }
    return stylize(src, 'green');
  }

  function extractHost(rec){
    return rec.hostname || '<no-hostname>';
  }

  function isSingleLineMsg(rec){
    return rec.msg.indexOf('\n') === -1;
  }

  function extractMsg(rec){
    return stylize(rec.msg, 'cyan');
  }

  function extractReqDetail(rec){
    if (rec.req && typeof (rec.req) === 'object') {
      var req = rec.req;
      var headers = req.headers;

      var str = format('%s %s HTTP/%s%s%s',
        req.method,
        req.url,
        req.httpVersion || '1.1',
        (req.remoteAddress ? "\nremote: " + req.remoteAddress + ":" + req.remotePort : ""),
        (headers ?
         '\n' + Object.keys(headers).map(function (h) {
           return h + ': ' + headers[h];
         }).join('\n') :
         '')
      );

      if (req.body) {
        str += '\n\n' + (typeof (req.body) === 'object' ? JSON_stringify(req.body, null, 2) : req.body);
      }
      if (req.trailers && Object.keys(req.trailers) > 0) {
        str += '\n' + Object.keys(req.trailers).map(function (t) {
          return t + ': ' + req.trailers[t];
        }).join('\n');
      }

      var skip = ['headers', 'url', 'httpVersion', 'body', 'trailers', 'method', 'remoteAddress', 'remotePort'];

      var extras = {};

      Object.keys(req).forEach(function (k) {
        if (skip.indexOf(k) === -1){
          extras['req.' + k] = req[k];
        }
      });

      return {
        details: [str],
        extras: extras
      };
    }
  }

  function genericRes(res) {
    var s = '';

    if (res.statusCode) {
      s += format('HTTP/1.1 %s %s\n', res.statusCode, http.STATUS_CODES[res.statusCode]);
    }

    // Handle `res.header` or `res.headers` as either a string or
    // and object of header key/value pairs. Prefer `res.header` if set
    // (TODO: Why? I don't recall. Typical of restify serializer?
    // Typical JSON.stringify of a core node HttpResponse?)
    var headers;
    if (res.header !== undefined) {
      headers = res.header;
    } else if (res.headers !== undefined) {
      headers = res.headers;
    }

    if (!headers) {
      // pass through
    } else if (typeof(headers) === 'string') {
      s += headers.trimRight();
    } else {
      s += Object.keys(headers).map(
        function (h) { return h + ': ' + headers[h]; }).join('\n');
    }

    if (res.body) {
      s += '\n\n' + (typeof (res.body) === 'object' ? JSON_stringify(res.body, null, 2) : res.body);
    }
    if (res.trailer) {
      s += '\n' + res.trailer;
    }

    var skip = ['header', 'statusCode', 'headers', 'body', 'trailer'];

    var extras = {};

    Object.keys(res).forEach(function (k) {
      if (skip.indexOf(k) === -1){
        extras['res.' + k] = res[k];
      }
    });

    return {
      details: [s],
      extras: extras
    };
  }

  function extractResDetail(rec){
    if (rec.res && typeof (rec.res) === 'object') {
      return genericRes(rec.res);
    }
  }

  function extractClientReqDetail(rec){
    if (rec.client_req && typeof (rec.client_req) === 'object') {
      var client_req = rec.client_req;

      var headers = client_req.headers;
      var hostHeaderLine = '';
      var s = '';

      if (client_req.address) {
        hostHeaderLine = 'Host: ' + client_req.address;

        if (client_req.port) {
          hostHeaderLine += ':' + client_req.port;
        }

        hostHeaderLine += '\n';
      }

      s += format('%s %s HTTP/%s\n%s%s', client_req.method,
        client_req.url,
        client_req.httpVersion || '1.1',
        hostHeaderLine,
        (headers ?
         Object.keys(headers).map(
           function (h) {
             return h + ': ' + headers[h];
           }).join('\n') :
         ''));

      if (client_req.body) {
        s += '\n\n' + (typeof (client_req.body) === 'object' ?
                       JSON_stringify(client_req.body, null, 2) :
                       client_req.body);
      }

      var skip = ['headers', 'url', 'httpVersion', 'body', 'trailers', 'method', 'remoteAddress', 'remotePort'];

      var extras = {};

      Object.keys(client_req).forEach(function (k) {
        if (skip.indexOf(k) === -1){
          extras['client_req.' + k] = client_req[k];
        }
      });

      return {
        details: [s],
        extras: extras
      };
    }
  }

  function extractClientResDetail(rec){
    if (rec.client_res && typeof (rec.client_res) === 'object') {
      return genericRes(rec.client_res);
    }
  }

  function extractError(rec){
    if (rec.err && rec.err.stack) {
      return rec.err.stack;
    }
  }

  function extractCustomDetails(rec){
    var skip = ['name', 'hostname', 'pid', 'level', 'component', 'msg', 'time', 'v', 'src', 'err', 'client_req', 'client_res', 'req', 'res'];

    var details = [];
    var extras = {};

    Object.keys(rec).forEach(function(key) {
      if (skip.indexOf(key) === -1){
        var value = rec[key];
        if (typeof value === 'undefined') value = '';
        var stringified = false;
        if (typeof value === 'function') {
          value = '[Function]';
          stringified = true;
        } else if (typeof value !== 'string') {
          value = JSON_stringify(value, null, 2);
          stringified = true;
        }
        if (value.indexOf('\n') !== -1 || value.length > 50) {
          details.push(key + ': ' + value);
        } else if (!stringified && (value.indexOf(' ') != -1 ||  value.length === 0)){
          extras[key] = JSON_stringify(value);
        } else {
          extras[key] = value;
        }
      }
    });

    return {
      details: details,
      extras: extras
    };
  }

  function applyDetails(results, details, extras){
    if (results){
      results.details.forEach(function(d){
        details.push(indent(d));
      });
      Object.keys(results.extras).forEach(function(k){
        try {
          extras.push(k + '=' + val);
        } catch(e) {}
      });
    }
  }

  this.formatRecord = function formatRecord(rec){
    var details = [];
    var extras = [];

    var time = extractTime(rec);
    var level = extractLevel(rec);
    var name = extractName(rec);
    var host = extractHost(rec);
    var src = extractSrc(rec);

    var msg = isSingleLineMsg(rec) ? extractMsg(rec) : '';
    if (!msg){
      details.push(indent(extractMsg(rec)));
    }

    var error = extractError(rec);
    if (error){
      details.push(indent(error));
    }

    if (rec.req){ applyDetails(extractReqDetail(rec), details, extras); }
    if (rec.res){ applyDetails(extractResDetail(rec), details, extras); }
    if (rec.client_req){ applyDetails(extractClientReqDetail(rec), details, extras); }
    if (rec.client_res){ applyDetails(extractClientResDetail(rec), details, extras); }

    applyDetails(extractCustomDetails(rec), details, extras);

    extras = stylize(
      (extras.length ? ' (' + extras.join(', ') + ')' : ''), 'grey');
    details = stylize(
      (details.length ? details.join('\n    --\n') + '\n' : ''), 'grey');

    if (typeof config.mode === 'function') {
      return config.mode(time, level, name, host, src, msg, extras, details);
    }

    if (config.mode === 'short'){
      return format('[%s] %s %s: %s%s\n%s',
        time,
        level,
        name,
        msg,
        extras,
        details);
    }
    else if (config.mode === 'dev'){
      return format('%s %s %s %s: %s%s\n%s',
        time,
        level,
        name,
        src,
        msg,
        extras,
        details);
    }
    else if (config.mode === 'none'){
      return format('%s%s\n%s',
        msg,
        extras,
        details);
    }
    else { //if (config.mode === 'long'){
      return format('[%s] %s: %s on %s%s: %s%s\n%s',
        time,
        level,
        name,
        host,
        src,
        msg,
        extras,
        details);
    }
  };
}

util.inherits(PrettyStream, Stream);

PrettyStream.prototype.write = function write(data){
  if (typeof data === 'string') {
    this.emit('data', this.formatRecord(JSON.parse(data)));
  }else if(typeof data === 'object'){
    this.emit('data', this.formatRecord(data));
  }
  return true;
};

PrettyStream.prototype.end = function end(){
  this.emit('end');
  return true;
};

// Track if we're piping into a TTY.
PrettyStream.prototype.pipe = function(dest, options) {
  this.isTTY = dest.isTTY;
  return Stream.prototype.pipe.call(this, dest, options);
};

module.exports = PrettyStream;

'use strict';

var Papa = {};
Papa.parse = CsvToJson;
Papa.unparse = JsonToCsv;

Papa.RECORD_SEP = String.fromCharCode(30);
Papa.UNIT_SEP = String.fromCharCode(31);
Papa.BYTE_ORDER_MARK = "\ufeff";
Papa.BAD_DELIMITERS = ["\r", "\n", "\"", Papa.BYTE_ORDER_MARK];
Papa.WORKERS_SUPPORTED = false;
Papa.SCRIPT_PATH = null;	// Must be set by your code if you use workers and this lib is loaded asynchronously

// Configurable chunk sizes for local and remote files, respectively
Papa.LocalChunkSize = 1024 * 1024 * 10;	// 10 MB
Papa.RemoteChunkSize = 1024 * 1024 * 5;	// 5 MB
Papa.DefaultDelimiter = ",";			// Used if not specified and detection fails

// Exposed for testing and development only
Papa.Parser = Parser;
Papa.ParserHandle = ParserHandle;
Papa.StringStreamer = StringStreamer;

function CsvToJson(_input, _config)
{
    _config = _config || {};

    var streamer = null;
    if (typeof _input === 'string')
    {
        streamer = new StringStreamer(_config);
    }

    return streamer.stream(_input);
}

function JsonToCsv(_input, _config)
{
    var _output = "";
    var _fields = [];

    // Default configuration

    /** whether to surround every datum with quotes */
    var _quotes = false;

    /** delimiting character */
    var _delimiter = ",";

    /** newline character(s) */
    var _newline = "\r\n";

    unpackConfig();

    if (typeof _input === 'string')
        _input = JSON.parse(_input);

    if (_input instanceof Array)
    {
        if (!_input.length || _input[0] instanceof Array)
            return serialize(null, _input);
        else if (typeof _input[0] === 'object')
            return serialize(objectKeys(_input[0]), _input);
    }
    else if (typeof _input === 'object')
    {
        if (typeof _input.data === 'string')
            _input.data = JSON.parse(_input.data);

        if (_input.data instanceof Array)
        {
            if (!_input.fields)
                _input.fields = _input.data[0] instanceof Array
                                ? _input.fields
                                : objectKeys(_input.data[0]);

            if (!(_input.data[0] instanceof Array) && typeof _input.data[0] !== 'object')
                _input.data = [_input.data];	// handles input like [1,2,3] or ["asdf"]
        }

        return serialize(_input.fields || [], _input.data || []);
    }

    // Default (any valid paths should return before this)
    throw "exception: Unable to serialize unrecognized input";


    function unpackConfig()
    {
        if (typeof _config !== 'object')
            return;

        if (typeof _config.delimiter === 'string'
            && _config.delimiter.length == 1
            && Papa.BAD_DELIMITERS.indexOf(_config.delimiter) == -1)
        {
            _delimiter = _config.delimiter;
        }

        if (typeof _config.quotes === 'boolean'
            || _config.quotes instanceof Array)
            _quotes = _config.quotes;

        if (typeof _config.newline === 'string')
            _newline = _config.newline;
    }


    /** Turns an object's keys into an array */
    function objectKeys(obj)
    {
        if (typeof obj !== 'object')
            return [];
        var keys = [];
        for (var key in obj)
            keys.push(key);
        return keys;
    }

    /** The double for loop that iterates the data and writes out a CSV string including header row */
    function serialize(fields, data)
    {
        var csv = "";

        if (typeof fields === 'string')
            fields = JSON.parse(fields);
        if (typeof data === 'string')
            data = JSON.parse(data);

        var hasHeader = fields instanceof Array && fields.length > 0;
        var dataKeyedByField = !(data[0] instanceof Array);

        // If there a header row, write it first
        if (hasHeader)
        {
            for (var i = 0; i < fields.length; i++)
            {
                if (i > 0)
                    csv += _delimiter;
                csv += safe(fields[i], i);
            }
            if (data.length > 0)
                csv += _newline;
        }

        // Then write out the data
        for (var row = 0; row < data.length; row++)
        {
            var maxCol = hasHeader ? fields.length : data[row].length;

            for (var col = 0; col < maxCol; col++)
            {
                if (col > 0)
                    csv += _delimiter;
                var colIdx = hasHeader && dataKeyedByField ? fields[col] : col;
                csv += safe(data[row][colIdx], col);
            }

            if (row < data.length - 1)
                csv += _newline;
        }

        return csv;
    }

    /** Encloses a value around quotes if needed (makes a value safe for CSV insertion) */
    function safe(str, col)
    {
        if (typeof str === "undefined" || str === null)
            return "";

        str = str.toString().replace(/"/g, '""');

        var needsQuotes = (typeof _quotes === 'boolean' && _quotes)
                        || (_quotes instanceof Array && _quotes[col])
                        || hasAny(str, Papa.BAD_DELIMITERS)
                        || str.indexOf(_delimiter) > -1
                        || str.charAt(0) == ' '
                        || str.charAt(str.length - 1) == ' ';

        return needsQuotes ? '"' + str + '"' : str;
    }

    function hasAny(str, substrings)
    {
        for (var i = 0; i < substrings.length; i++)
            if (str.indexOf(substrings[i]) > -1)
                return true;
        return false;
    }
}

/** ChunkStreamer is the base prototype for various streamer implementations. */
function ChunkStreamer(config)
{
    this._handle = null;
    this._paused = false;
    this._finished = false;
    this._input = null;
    this._baseIndex = 0;
    this._partialLine = "";
    this._rowCount = 0;
    this._start = 0;
    this._nextChunk = null;
    this.isFirstChunk = true;
    this._completeResults = {
        data: [],
        errors: [],
        meta: {}
    };
    replaceConfig.call(this, config);

    this.parseChunk = function(chunk)
    {
        // First chunk pre-processing
        if (this.isFirstChunk && isFunction(this._config.beforeFirstChunk))
        {
            var modifiedChunk = this._config.beforeFirstChunk(chunk);
            if (modifiedChunk !== undefined)
                chunk = modifiedChunk;
        }
        this.isFirstChunk = false;

        // Rejoin the line we likely just split in two by chunking the file
        var aggregate = this._partialLine + chunk;
        this._partialLine = "";

        var results = this._handle.parse(aggregate, this._baseIndex, !this._finished);

        if (this._handle.paused() || this._handle.aborted())
            return;

        var lastIndex = results.meta.cursor;

        if (!this._finished)
        {
            this._partialLine = aggregate.substring(lastIndex - this._baseIndex);
            this._baseIndex = lastIndex;
        }

        if (results && results.data)
            this._rowCount += results.data.length;

        var finishedIncludingPreview = this._finished || (this._config.preview && this._rowCount >= this._config.preview);

        if (isFunction(this._config.chunk))
        {
            this._config.chunk(results, this._handle);
            if (this._paused)
                return;
            results = undefined;
            this._completeResults = undefined;
        }

        if (!this._config.step && !this._config.chunk) {
            this._completeResults.data = this._completeResults.data.concat(results.data);
            this._completeResults.errors = this._completeResults.errors.concat(results.errors);
            this._completeResults.meta = results.meta;
        }

        if (finishedIncludingPreview && isFunction(this._config.complete) && (!results || !results.meta.aborted))
            this._config.complete(this._completeResults);

        if (!finishedIncludingPreview && (!results || !results.meta.paused))
            this._nextChunk();

        return results;
    };

    this._sendError = function(error)
    {
        if (isFunction(this._config.error))
            this._config.error(error);
    };

    function replaceConfig(config)
    {
        // Deep-copy the config so we can edit it
        var configCopy = copy(config);
        configCopy.chunkSize = parseInt(configCopy.chunkSize);	// parseInt VERY important so we don't concatenate strings!
        if (!config.step && !config.chunk)
            configCopy.chunkSize = null;  // disable Range header if not streaming; bad values break IIS - see issue #196
        this._handle = new ParserHandle(configCopy);
        this._handle.streamer = this;
        this._config = configCopy;	// persist the copy to the caller
    }
}

function StringStreamer(config)
{
    config = config || {};
    ChunkStreamer.call(this, config);

    var string;
    var remaining;
    this.stream = function(s)
    {
        string = s;
        remaining = s;
        return this._nextChunk();
    };
    this._nextChunk = function()
    {
        if (this._finished) return;
        var size = this._config.chunkSize;
        var chunk = size ? remaining.substr(0, size) : remaining;
        remaining = size ? remaining.substr(size) : '';
        this._finished = !remaining;
        return this.parseChunk(chunk);
    };
}
StringStreamer.prototype = Object.create(StringStreamer.prototype);
StringStreamer.prototype.constructor = StringStreamer;



// Use one ParserHandle per entire CSV file or string
function ParserHandle(_config)
{
    // One goal is to minimize the use of regular expressions...
    var FLOAT = /^\s*-?(\d*\.?\d+|\d+\.?\d*)(e[-+]?\d+)?\s*$/i;

    var self = this;
    var _stepCounter = 0;	// Number of times step was called (number of rows parsed)
    var _input;				// The input being parsed
    var _parser;			// The core parser being used
    var _paused = false;	// Whether we are paused or not
    var _aborted = false;   // Whether the parser has aborted or not
    var _delimiterError;	// Temporary state between delimiter detection and processing results
    var _fields = [];		// Fields are from the header row of the input, if there is one
    var _results = {		// The last results returned from the parser
        data: [],
        errors: [],
        meta: {}
    };

    if (isFunction(_config.step))
    {
        var userStep = _config.step;
        _config.step = function(results)
        {
            _results = results;

            if (needsHeaderRow())
                processResults();
            else	// only call user's step function after header row
            {
                processResults();

                // It's possbile that this line was empty and there's no row here after all
                if (_results.data.length == 0)
                    return;

                _stepCounter += results.data.length;
                if (_config.preview && _stepCounter > _config.preview)
                    _parser.abort();
                else
                    userStep(_results, self);
            }
        };
    }

    /**
     * Parses input. Most users won't need, and shouldn't mess with, the baseIndex
     * and ignoreLastRow parameters. They are used by streamers (wrapper functions)
     * when an input comes in multiple chunks, like from a file.
     */
    this.parse = function(input, baseIndex, ignoreLastRow)
    {
        if (!_config.newline)
            _config.newline = guessLineEndings(input);

        _delimiterError = false;
        if (!_config.delimiter)
        {
            var delimGuess = guessDelimiter(input);
            if (delimGuess.successful)
                _config.delimiter = delimGuess.bestDelimiter;
            else
            {
                _delimiterError = true;	// add error after parsing (otherwise it would be overwritten)
                _config.delimiter = Papa.DefaultDelimiter;
            }
            _results.meta.delimiter = _config.delimiter;
        }

        var parserConfig = copy(_config);
        if (_config.preview && _config.header)
            parserConfig.preview++;	// to compensate for header row

        _input = input;
        _parser = new Parser(parserConfig);
        _results = _parser.parse(_input, baseIndex, ignoreLastRow);
        processResults();
        return _paused ? { meta: { paused: true } } : (_results || { meta: { paused: false } });
    };

    this.paused = function()
    {
        return _paused;
    };

    this.pause = function()
    {
        _paused = true;
        _parser.abort();
        _input = _input.substr(_parser.getCharIndex());
    };

    this.resume = function()
    {
        _paused = false;
        self.streamer.parseChunk(_input);
    };

    this.aborted = function () {
        return _aborted;
    };

    this.abort = function()
    {
        _aborted = true;
        _parser.abort();
        _results.meta.aborted = true;
        if (isFunction(_config.complete))
            _config.complete(_results);
        _input = "";
    };

    function processResults()
    {
        if (_results && _delimiterError)
        {
            addError("Delimiter", "UndetectableDelimiter", "Unable to auto-detect delimiting character; defaulted to '"+Papa.DefaultDelimiter+"'");
            _delimiterError = false;
        }

        if (_config.skipEmptyLines)
        {
            for (var i = 0; i < _results.data.length; i++)
                if (_results.data[i].length == 1 && _results.data[i][0] == "")
                    _results.data.splice(i--, 1);
        }

        if (needsHeaderRow())
            fillHeaderFields();

        return applyHeaderAndDynamicTyping();
    }

    function needsHeaderRow()
    {
        return _config.header && _fields.length == 0;
    }

    function fillHeaderFields()
    {
        if (!_results)
            return;
        for (var i = 0; needsHeaderRow() && i < _results.data.length; i++)
            for (var j = 0; j < _results.data[i].length; j++)
                _fields.push(_results.data[i][j]);
        _results.data.splice(0, 1);
    }

    function applyHeaderAndDynamicTyping()
    {
        if (!_results || (!_config.header && !_config.dynamicTyping))
            return _results;

        for (var i = 0; i < _results.data.length; i++)
        {
            var row = {};

            for (var j = 0; j < _results.data[i].length; j++)
            {
                if (_config.dynamicTyping)
                {
                    var value = _results.data[i][j];
                    if (value == "true" || value == "TRUE")
                        _results.data[i][j] = true;
                    else if (value == "false" || value == "FALSE")
                        _results.data[i][j] = false;
                    else
                        _results.data[i][j] = tryParseFloat(value);
                }

                if (_config.header)
                {
                    if (j >= _fields.length)
                    {
                        if (!row["__parsed_extra"])
                            row["__parsed_extra"] = [];
                        row["__parsed_extra"].push(_results.data[i][j]);
                    }
                    else
                        row[_fields[j]] = _results.data[i][j];
                }
            }

            if (_config.header)
            {
                _results.data[i] = row;
                if (j > _fields.length)
                    addError("FieldMismatch", "TooManyFields", "Too many fields: expected " + _fields.length + " fields but parsed " + j, i);
                else if (j < _fields.length)
                    addError("FieldMismatch", "TooFewFields", "Too few fields: expected " + _fields.length + " fields but parsed " + j, i);
            }
        }

        if (_config.header && _results.meta)
            _results.meta.fields = _fields;
        return _results;
    }

    function guessDelimiter(input)
    {
        var delimChoices = [",", "\t", "|", ";", Papa.RECORD_SEP, Papa.UNIT_SEP];
        var bestDelim, bestDelta, fieldCountPrevRow;

        for (var i = 0; i < delimChoices.length; i++)
        {
            var delim = delimChoices[i];
            var delta = 0, avgFieldCount = 0;
            fieldCountPrevRow = undefined;

            var preview = new Parser({
                delimiter: delim,
                preview: 10
            }).parse(input);

            for (var j = 0; j < preview.data.length; j++)
            {
                var fieldCount = preview.data[j].length;
                avgFieldCount += fieldCount;

                if (typeof fieldCountPrevRow === 'undefined')
                {
                    fieldCountPrevRow = fieldCount;
                    continue;
                }
                else if (fieldCount > 1)
                {
                    delta += Math.abs(fieldCount - fieldCountPrevRow);
                    fieldCountPrevRow = fieldCount;
                }
            }

            if (preview.data.length > 0)
                avgFieldCount /= preview.data.length;

            if ((typeof bestDelta === 'undefined' || delta < bestDelta)
                && avgFieldCount > 1.99)
            {
                bestDelta = delta;
                bestDelim = delim;
            }
        }

        _config.delimiter = bestDelim;

        return {
            successful: !!bestDelim,
            bestDelimiter: bestDelim
        };
    }

    function guessLineEndings(input)
    {
        input = input.substr(0, 1024*1024);	// max length 1 MB

        var r = input.split('\r');

        if (r.length == 1)
            return '\n';

        var numWithN = 0;
        for (var i = 0; i < r.length; i++)
        {
            if (r[i][0] == '\n')
                numWithN++;
        }

        return numWithN >= r.length / 2 ? '\r\n' : '\r';
    }

    function tryParseFloat(val)
    {
        var isNumber = FLOAT.test(val);
        return isNumber ? parseFloat(val) : val;
    }

    function addError(type, code, msg, row)
    {
        _results.errors.push({
            type: type,
            code: code,
            message: msg,
            row: row
        });
    }
}

/** The core parser implements speedy and correct CSV parsing */
function Parser(config)
{
    // Unpack the config object
    config = config || {};
    var delim = config.delimiter;
    var newline = config.newline;
    var comments = config.comments;
    var step = config.step;
    var preview = config.preview;
    var fastMode = config.fastMode;

    // Delimiter must be valid
    if (typeof delim !== 'string'
        || Papa.BAD_DELIMITERS.indexOf(delim) > -1)
        delim = ",";

    // Comment character must be valid
    if (comments === delim)
        throw "Comment character same as delimiter";
    else if (comments === true)
        comments = "#";
    else if (typeof comments !== 'string'
        || Papa.BAD_DELIMITERS.indexOf(comments) > -1)
        comments = false;

    // Newline must be valid: \r, \n, or \r\n
    if (newline != '\n' && newline != '\r' && newline != '\r\n')
        newline = '\n';

    // We're gonna need these at the Parser scope
    var cursor = 0;
    var aborted = false;

    this.parse = function(input, baseIndex, ignoreLastRow)
    {
        // For some reason, in Chrome, this speeds things up (!?)
        if (typeof input !== 'string')
            throw "Input must be a string";

        // We don't need to compute some of these every time parse() is called,
        // but having them in a more local scope seems to perform better
        var inputLen = input.length,
            delimLen = delim.length,
            newlineLen = newline.length,
            commentsLen = comments.length;
        var stepIsFunction = typeof step === 'function';

        // Establish starting state
        cursor = 0;
        var data = [], errors = [], row = [], lastCursor = 0;

        if (!input)
            return returnable();

        if (fastMode || (fastMode !== false && input.indexOf('"') === -1))
        {
            var rows = input.split(newline);
            for (var i = 0; i < rows.length; i++)
            {
                var row = rows[i];
                cursor += row.length;
                if (i !== rows.length - 1)
                    cursor += newline.length;
                else if (ignoreLastRow)
                    return returnable();
                if (comments && row.substr(0, commentsLen) == comments)
                    continue;
                if (stepIsFunction)
                {
                    data = [];
                    pushRow(row.split(delim));
                    doStep();
                    if (aborted)
                        return returnable();
                }
                else
                    pushRow(row.split(delim));
                if (preview && i >= preview)
                {
                    data = data.slice(0, preview);
                    return returnable(true);
                }
            }
            return returnable();
        }

        var nextDelim = input.indexOf(delim, cursor);
        var nextNewline = input.indexOf(newline, cursor);

        // Parser loop
        for (;;)
        {
            // Field has opening quote
            if (input[cursor] == '"')
            {
                // Start our search for the closing quote where the cursor is
                var quoteSearch = cursor;

                // Skip the opening quote
                cursor++;

                for (;;)
                {
                    // Find closing quote
                    var quoteSearch = input.indexOf('"', quoteSearch+1);

                    if (quoteSearch === -1)
                    {
                        if (!ignoreLastRow) {
                            // No closing quote... what a pity
                            errors.push({
                                type: "Quotes",
                                code: "MissingQuotes",
                                message: "Quoted field unterminated",
                                row: data.length,	// row has yet to be inserted
                                index: cursor
                            });
                        }
                        return finish();
                    }

                    if (quoteSearch === inputLen-1)
                    {
                        // Closing quote at EOF
                        var value = input.substring(cursor, quoteSearch).replace(/""/g, '"');
                        return finish(value);
                    }

                    // If this quote is escaped, it's part of the data; skip it
                    if (input[quoteSearch+1] == '"')
                    {
                        quoteSearch++;
                        continue;
                    }

                    if (input[quoteSearch+1] == delim)
                    {
                        // Closing quote followed by delimiter
                        row.push(input.substring(cursor, quoteSearch).replace(/""/g, '"'));
                        cursor = quoteSearch + 1 + delimLen;
                        nextDelim = input.indexOf(delim, cursor);
                        nextNewline = input.indexOf(newline, cursor);
                        break;
                    }

                    if (input.substr(quoteSearch+1, newlineLen) === newline)
                    {
                        // Closing quote followed by newline
                        row.push(input.substring(cursor, quoteSearch).replace(/""/g, '"'));
                        saveRow(quoteSearch + 1 + newlineLen);
                        nextDelim = input.indexOf(delim, cursor);	// because we may have skipped the nextDelim in the quoted field

                        if (stepIsFunction)
                        {
                            doStep();
                            if (aborted)
                                return returnable();
                        }

                        if (preview && data.length >= preview)
                            return returnable(true);

                        break;
                    }
                }

                continue;
            }

            // Comment found at start of new line
            if (comments && row.length === 0 && input.substr(cursor, commentsLen) === comments)
            {
                if (nextNewline == -1)	// Comment ends at EOF
                    return returnable();
                cursor = nextNewline + newlineLen;
                nextNewline = input.indexOf(newline, cursor);
                nextDelim = input.indexOf(delim, cursor);
                continue;
            }

            // Next delimiter comes before next newline, so we've reached end of field
            if (nextDelim !== -1 && (nextDelim < nextNewline || nextNewline === -1))
            {
                row.push(input.substring(cursor, nextDelim));
                cursor = nextDelim + delimLen;
                nextDelim = input.indexOf(delim, cursor);
                continue;
            }

            // End of row
            if (nextNewline !== -1)
            {
                row.push(input.substring(cursor, nextNewline));
                saveRow(nextNewline + newlineLen);

                if (stepIsFunction)
                {
                    doStep();
                    if (aborted)
                        return returnable();
                }

                if (preview && data.length >= preview)
                    return returnable(true);

                continue;
            }

            break;
        }


        return finish();


        function pushRow(row)
        {
            data.push(row);
            lastCursor = cursor;
        }

        /**
         * Appends the remaining input from cursor to the end into
         * row, saves the row, calls step, and returns the results.
         */
        function finish(value)
        {
            if (ignoreLastRow)
                return returnable();
            if (typeof value === 'undefined')
                value = input.substr(cursor);
            row.push(value);
            cursor = inputLen;	// important in case parsing is paused
            pushRow(row);
            if (stepIsFunction)
                doStep();
            return returnable();
        }

        /**
         * Appends the current row to the results. It sets the cursor
         * to newCursor and finds the nextNewline. The caller should
         * take care to execute user's step function and check for
         * preview and end parsing if necessary.
         */
        function saveRow(newCursor)
        {
            cursor = newCursor;
            pushRow(row);
            row = [];
            nextNewline = input.indexOf(newline, cursor);
        }

        /** Returns an object with the results, errors, and meta. */
        function returnable(stopped)
        {
            return {
                data: data,
                errors: errors,
                meta: {
                    delimiter: delim,
                    linebreak: newline,
                    aborted: aborted,
                    truncated: !!stopped,
                    cursor: lastCursor + (baseIndex || 0)
                }
            };
        }

        /** Executes the user's step function and resets data & errors. */
        function doStep()
        {
            step(returnable());
            data = [], errors = [];
        }
    };

    /** Sets the abort flag */
    this.abort = function()
    {
        aborted = true;
    };

    /** Gets the cursor position */
    this.getCharIndex = function()
    {
        return cursor;
    };
}


function notImplemented() {
    throw "Not implemented.";
}

/** Makes a deep copy of an array or object (mostly) */
function copy(obj)
{
    if (typeof obj !== 'object')
        return obj;
    var cpy = obj instanceof Array ? [] : {};
    for (var key in obj)
        cpy[key] = copy(obj[key]);
    return cpy;
}

function bindFunction(f, self)
{
    return function() { f.apply(self, arguments); };
}

function isFunction(func)
{
    return typeof func === 'function';
}

var Zap = {
  new_order_by_stage_post_poll: function(bundle) {
    var jsonArray = Papa.parse(bundle.response.content, {header: true}).data;  
    var orders = Zap.processOrders(jsonArray);
      return _.map(orders, function(order) {
        order.international_phone = z.dehydrate('internationalise_phone', {phone_number: order.Phone, country_code: order.DeliveryCountry});
        return order;
      });
  },
   
  new_order_post_poll: function(bundle) {
    var jsonArray = Papa.parse(bundle.response.content, {header: true}).data;  
    var orders = Zap.processOrders(jsonArray);
      return _.map(orders, function(order) {
        order.international_phone = z.dehydrate('internationalise_phone', {phone_number: order.Phone, country_code: order.DeliveryCountry});
        return order;
      });
  },
  
    new_order_by_stage_with_items_post_poll: function(bundle) {
      var jsonArray = Papa.parse(bundle.response.content, {header: true}).data;  
      var orders = Zap.processOrders(jsonArray);
      return _.map(orders, function(order) {
            order.orderLineItems = z.dehydrate('get_order_line_items', {orderId: order.OrderId, auth_fields: bundle.auth_fields});
            order.international_phone = z.dehydrate('internationalise_phone', {phone_number: order.Phone, country_code: order.DeliveryCountry});
            return order;
      });
    },

    new_order_with_line_items_post_poll: function(bundle) {
      var jsonArray = Papa.parse(bundle.response.content, {header: true}).data;  
      var orders = Zap.processOrders(jsonArray);
      return _.map(orders, function(order) {
            order.orderLineItems = z.dehydrate('get_order_line_items', {orderId: order.OrderId, auth_fields: bundle.auth_fields});
            order.international_phone = z.dehydrate('internationalise_phone', {phone_number: order.Phone, country_code: order.DeliveryCountry});
            return order;
      });
    },

  find_order_details_post_search: function(bundle) {
    var jsonArray = Papa.parse(bundle.response.content, {header: true}).data;  
    return Zap.orderDetailIdToId(jsonArray);
  },

  update_order_stage_by_ref_pre_write: function(bundle) {
    return Zap.jsonifyBundle(bundle);
  },

  update_order_stage_pre_write: function(bundle) {
    return Zap.jsonifyBundle(bundle);
  },

  
  processOrders: function(array) {
    for (var i = 0; i < array.length; i++) {
      array[i].id = array[i].OrderId;
    }
    return array;
  },

  orderDetailIdToId: function(array) {
    for (var i = 0; i < array.length; i++) {
      array[i].id = array[i].OrderDetailId; 
    }
    return array;
  },
  
  internationalise_phone: function(bundle) {
    var phone_number = bundle.phone_number;
    var country_code = bundle.country_code;
    var request = {
      'method': 'GET',
      'url': 'https://pacific-fjord-85422.herokuapp.com/format/' + country_code + 
              '/' + phone_number
      };
    var international_format_phone = JSON.parse(z.request(request).content);
    if (international_format_phone.hasOwnProperty('international_format')) {
      return international_format_phone.international_format;
    }
    return "";
  },
  
  get_order_line_items: function(bundle) {
    var request = {
      'method': 'GET',
      'url': 'https://api.cin7.com/cloud/APILite/APILite.ashx?apiid=' + bundle.auth_fields.apiid + 
              '&apikey=' + bundle.auth_fields.apikey + 
              '&action=GetOrderDetails&where=OrderId = ' + bundle.orderId +
              '&orderby = \'OrderDetailId\''
      };
    var orderItemsCSV = z.request(request).content;
    return Papa.parse(orderItemsCSV, {header: true}).data;
  },
  
  jsonifyBundle: function(bundle) {
    return {
      url: bundle.request.url,
      method: bundle.request.method,
      auth: bundle.request.auth,
      headers: bundle.request.headers,
      params: bundle.request.params,
      data: Papa.unparse([].concat(JSON.parse(bundle.request.data)))
    };
  }
};

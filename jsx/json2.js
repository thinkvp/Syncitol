/*
 * json2.js - minimal JSON polyfill for ExtendScript engines without native JSON.
 *
 * Adapted from Douglas Crockford's public-domain json2.js, trimmed to the
 * stringify/parse surface Syncitol uses (plain objects, arrays, strings,
 * finite numbers, booleans, null). It is fully guarded: when the host already
 * provides a native JSON object (modern Premiere builds do), this file defines
 * nothing and is a no-op. Load it before sync.jsx.
 */

if (typeof JSON === "undefined" || !JSON) {
    JSON = {};
}

(function () {
    "use strict";

    // Escape backslash, double-quote and ASCII control characters. The payloads
    // exchanged here are file paths, clip names and numbers, so the high-Unicode
    // format-character ranges from the full json2.js are not needed.
    var escapable = /[\\\"\x00-\x1f]/g,
        meta = {
            "\b": "\\b", "\t": "\\t", "\n": "\\n",
            "\f": "\\f", "\r": "\\r", "\"": "\\\"", "\\": "\\\\"
        };

    function quote(string) {
        escapable.lastIndex = 0;
        return escapable.test(string)
            ? "\"" + string.replace(escapable, function (a) {
                var c = meta[a];
                return typeof c === "string"
                    ? c
                    : "\\u" + ("0000" + a.charCodeAt(0).toString(16)).slice(-4);
            }) + "\""
            : "\"" + string + "\"";
    }

    function str(key, holder) {
        var i, k, v, length, partial, value = holder[key];

        switch (typeof value) {
        case "string":
            return quote(value);
        case "number":
            return isFinite(value) ? String(value) : "null";
        case "boolean":
        case "null":
            return String(value);
        case "object":
            if (!value) return "null";
            partial = [];
            if (Object.prototype.toString.apply(value) === "[object Array]") {
                length = value.length;
                for (i = 0; i < length; i += 1) {
                    partial[i] = str(i, value) || "null";
                }
                return partial.length === 0 ? "[]" : "[" + partial.join(",") + "]";
            }
            for (k in value) {
                if (Object.prototype.hasOwnProperty.call(value, k)) {
                    v = str(k, value);
                    if (v) partial.push(quote(k) + ":" + v);
                }
            }
            return partial.length === 0 ? "{}" : "{" + partial.join(",") + "}";
        }
    }

    if (typeof JSON.stringify !== "function") {
        JSON.stringify = function (value) {
            return str("", { "": value });
        };
    }

    if (typeof JSON.parse !== "function") {
        JSON.parse = function (text) {
            text = String(text);
            // Accept only syntactically valid JSON, then eval it (json2 approach).
            if (/^[\],:{}\s]*$/.test(
                text.replace(/\\(?:["\\\/bfnrt]|u[0-9a-fA-F]{4})/g, "@")
                    .replace(/"[^"\\\n\r]*"|true|false|null|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?/g, "]")
                    .replace(/(?:^|:|,)(?:\s*\[)+/g, "")
            )) {
                return eval("(" + text + ")");
            }
            throw new SyntaxError("JSON.parse");
        };
    }
}());

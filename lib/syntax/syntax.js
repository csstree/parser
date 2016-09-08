var MatchError = require('./error').MatchError;
var List = require('../utils/list');
var names = require('../utils/names');
var generic = require('./generic');
var parse = require('./parse');
var walk = require('./walk');
var cssWideKeywords = parse('inherit | initial | unset');

function skipSpaces(node) {
    while (node !== null && (node.data.type === 'Space' || node.data.type === 'Comment')) {
        node = node.next;
    }

    return node;
}

function match(syntax, syntaxNode, node) {
    var result = [];
    var min = syntaxNode.min === 0 || syntaxNode.min ? syntaxNode.min : 1;
    var max = syntaxNode.max === null ? Infinity : (syntaxNode.max || 1);
    var lastCommaTermCount;
    var lastComma;
    var matchCount = 0;

    mismatch:
    while (matchCount < max) {
        node = skipSpaces(node);
        switch (syntaxNode.type) {
            case 'Sequence':
            case 'Group':
                next:
                switch (syntaxNode.combinator) {
                    case '|':
                        for (var i = 0; i < syntaxNode.terms.length; i++) {
                            var res = match(syntax, syntaxNode.terms[i], node);
                            if (res && res.match) {
                                result.push(res.match);
                                node = res.next;
                                break next;  // continue matching
                            }
                        }
                        break mismatch; // nothing found -> stop matching

                    case ' ':
                        var beforeMatchNode = node;
                        var lastMatchedTerm = null;
                        var hasTailMatch = false;
                        var commaMissed = false;
                        for (var i = 0; i < syntaxNode.terms.length; i++) {
                            var term = syntaxNode.terms[i];
                            var res = match(syntax, term, node);
                            if (res && res.match) {
                                if (term.type === 'Comma' && i !== 0 && !hasTailMatch) {
                                    // recover cursor to state before last match and stop matching
                                    node = beforeMatchNode;
                                    break mismatch;
                                }

                                // non-empty match
                                if (res.match.match.length) {
                                    // match should be preceded by a comma
                                    if (commaMissed) {
                                        node = beforeMatchNode;
                                        break mismatch;
                                    }

                                    hasTailMatch = term.type !== 'Comma';
                                    lastMatchedTerm = term;
                                }

                                result.push(res.match);
                                node = skipSpaces(res.next);
                            } else {
                                // it's ok when comma doesn't match when no matches yet
                                // but only if comma is not first or last term
                                if (term.type === 'Comma' && i !== 0 && i !== syntaxNode.terms.length - 1) {
                                    if (hasTailMatch) {
                                        commaMissed = true;
                                    }
                                    continue;
                                }

                                // recover cursor to state before last match and stop matching
                                node = beforeMatchNode;
                                break mismatch;
                            }
                        }

                        // don't allow empty match when [ ]!
                        if (!lastMatchedTerm && syntaxNode.nonEmpty) {
                            // empty match but shouldn't
                            // recover cursor to state before last match and stop matching
                            node = beforeMatchNode;
                            break mismatch;
                        }

                        // don't allow comma at the end but only if last term isn't a comma
                        if (lastMatchedTerm && lastMatchedTerm.type === 'Comma' && term.type !== 'Comma') {
                            node = beforeMatchNode;
                            break mismatch;
                        }

                        break;

                    case '&&':
                        var beforeMatchNode = node;
                        var lastMatchedTerm = null;
                        var terms = syntaxNode.terms.slice();

                        while (terms.length) {
                            var wasMatch = false;

                            for (var i = 0; i < terms.length; i++) {
                                var term = terms[i];
                                var res = match(syntax, term, node);
                                if (res && res.match) {
                                    // non-empty match
                                    if (res.match.match.length) {
                                        lastMatchedTerm = term;
                                    }

                                    wasMatch = true;
                                    terms.splice(i--, 1);
                                    result.push(res.match);
                                    node = skipSpaces(res.next);
                                    break;
                                }
                            }

                            if (!wasMatch) {
                                node = beforeMatchNode;
                                break mismatch;
                            }
                        }

                        if (!lastMatchedTerm && syntaxNode.nonEmpty) { // don't allow empty match when [ ]!
                            // empty match but shouldn't
                            // recover cursor to state before last match and stop matching
                            node = beforeMatchNode;
                            break mismatch;
                        }

                        break;

                    case '||':
                        var beforeMatchNode = node;
                        var lastMatchedTerm = null;
                        var terms = syntaxNode.terms.slice();

                        while (terms.length) {
                            var wasMatch = false;

                            for (var i = 0; i < terms.length; i++) {
                                var term = terms[i];
                                var res = match(syntax, term, node);
                                if (res && res.match) {
                                    // non-empty match
                                    if (res.match.match.length) {
                                        lastMatchedTerm = term;
                                    }

                                    wasMatch = true;
                                    terms.splice(i--, 1);
                                    result.push(res.match);
                                    node = skipSpaces(res.next);
                                    break;
                                }
                            }

                            if (!wasMatch) {
                                break;
                            }
                        }

                        if (!lastMatchedTerm) { // don't allow empty match
                            // empty match but shouldn't
                            // recover cursor to state before last match and stop matching
                            node = beforeMatchNode;
                            break mismatch;
                        }

                        break;

                    default:
                        throw new Error('Not implemented yet combinator: `' + syntaxNode.combinator + '`');
                }

                break;

            case 'Type':
                var typeSyntax = syntax.getType(syntaxNode.name);
                if (!typeSyntax) {
                    throw new Error('Unknown syntax type `' + syntaxNode.name + '`');
                }

                var res = typeSyntax.match(node);
                if (!res || !res.match) {
                    break mismatch;
                }

                result.push(res.match);
                node = res.next;
                break;

            case 'Function':
                // expect a function node
                if (!node || node.data.type !== 'Function') {
                    break mismatch;
                }

                var keyword = names.keyword(node.data.name);

                // check function name with vendor consideration
                if (syntaxNode.name !== keyword.vendor + keyword.name && syntaxNode.name !== keyword.name) {
                    break mismatch;
                }

                // convert arguments into plain list for now, otherwise it's become too complicated to match
                var list = new List();
                if (node) {
                    node.data.arguments.each(function(argument) {
                        if (list.head) {
                            list.insert(list.createItem({
                                type: 'Operator',
                                info: null,
                                value: ','
                            }));
                        }

                        list.appendList(argument.sequence.copy());
                    });
                }

                var res = match(syntax, syntaxNode.sequence, list.head);
                if (!res || !res.match || res.next) {
                    break mismatch;
                }

                result.push(res.match);
                // Use node.next instead of res.next here since syntax is matching
                // for internal list and it's should be completelly matched (res.next is null at this point).
                // Therefore function is matched and we going to next node
                node = node.next;
                break;

            case 'Property':
                var propertySyntax = syntax.getProperty(syntaxNode.name);
                if (!propertySyntax) {
                    throw new Error('Unknown property `' + syntaxNode.name + '`');
                }

                var res = propertySyntax.match(node);
                if (!res || !res.match) {
                    break mismatch;
                }

                result.push(res.match);
                node = res.next;
                break;

            case 'Keyword':
                if (!node || node.data.type !== 'Identifier') {
                    break mismatch;
                }

                var keyword = names.keyword(node.data.name);

                if (syntaxNode.name !== keyword.vendor + keyword.name && syntaxNode.name !== keyword.name) {
                    break mismatch;
                }

                result.push(node.data);
                node = node.next;
                break;

            case 'Slash':
            case 'Comma':
                if (!node || node.data.type !== 'Operator' || node.data.value !== syntaxNode.value) {
                    break mismatch;
                }

                result.push(node.data);
                node = node.next;
                break;

            default:
                throw new Error('Not implemented yet node type: ' + syntaxNode.type);
        }

        matchCount++;
        if (!node) {
            break;
        }

        if (syntaxNode.comma) {
            if (lastComma && lastCommaTermCount === result.length) {
                // nothing match after comma
                break mismatch;
            }

            node = skipSpaces(node);
            if (node && node.data.type === 'Operator' && node.data.value === ',') {
                lastCommaTermCount = result.length;
                lastComma = node;
                node = node.next;
            } else {
                break mismatch;
            }
        }
    }

    if (lastComma && lastCommaTermCount === result.length) {
        // nothing match after comma
        node = lastComma;
    }

    return {
        next: node,
        match: matchCount < min ? null : {
            type: syntaxNode.type,
            name: syntaxNode.name,
            match: result
        }
    };
}

function dumpMap(map) {
    var result = {};

    for (var name in map) {
        result[name] = {
            type: map[name].type,
            broken: map[name].broken,
            syntax: map[name].syntax
        };
    }

    return result;
}

var Syntax = function(syntax) {
    this.properties = {};
    this.types = {};

    if (syntax) {
        if (syntax.generic) {
            for (var name in generic) {
                this.addType(name, generic[name]);
            }
        }

        if (syntax.types) {
            for (var name in syntax.types) {
                this.addType(name, syntax.types[name]);
            }
        }

        if (syntax.properties) {
            for (var name in syntax.properties) {
                this.addProperty(name, syntax.properties[name]);
            }
        }
    }
};

Syntax.create = function(syntax) {
    return new Syntax(syntax);
};

Syntax.prototype = {
    createDescriptor: function(type, syntax) {
        var descriptor = {
            type: type,
            broken: null,
            syntax: null,
            match: null
        };

        if (typeof syntax === 'function') {
            descriptor.type = 'basic-type';
            descriptor.match = syntax;
        } else {
            descriptor.syntax = parse(syntax);
            descriptor.match = match.bind(null, this, descriptor.syntax);
        }

        return descriptor;
    },
    addProperty: function(name, syntax) {
        this.properties[name] = this.createDescriptor('Property', syntax);
    },
    addType: function(name, syntax) {
        this.types[name] = this.createDescriptor('Type', syntax);
    },

    match: function(propertyName, value) {
        var property = names.property(propertyName);
        var propertySyntax = property.vendor
            ? this.getProperty(property.vendor + property.name) || this.getProperty(property.name)
            : this.getProperty(property.name);
        var result;

        // console.log(JSON.stringify(propertySyntax.syntax, null, 4));
        // console.log(JSON.stringify(value, null, 4));
        // console.log('-----');
        // debugger;

        if (!propertySyntax) {
            throw new Error('Unknown property: ' + propertyName);
        }

        result = propertySyntax.match(value.sequence.head);

        if (!result || !result.match) {
            result = match(this, cssWideKeywords, value.sequence.head);
            if (!result || !result.match) {
                throw new MatchError('Mismatch', propertySyntax.syntax, value, result.next);
            }
        }

        if (result.next) {
            throw new MatchError('Uncomplete match', propertySyntax.syntax, value, result.next);
        }

        return result.match;
    },

    getProperty: function(name) {
        return this.properties.hasOwnProperty(name) ? this.properties[name] : null;
    },
    getType: function(name) {
        return this.types.hasOwnProperty(name) ? this.types[name] : null;
    },
    getAll: function() {
        var all = [];

        for (var name in this.types) {
            all.push(this.types[name]);
        }

        for (var name in this.properties) {
            all.push(this.properties[name]);
        }

        return all;
    },

    validate: function() {
        var all = this.getAll();

        // reset broken state
        all.forEach(function(descriptor) {
            descriptor.broken = null;
        });

        // compute new broken state
        all.forEach(function validate(descriptor) {
            if (descriptor.broken === null) {
                descriptor.broken = false;

                if (descriptor.syntax !== null) {
                    walk(descriptor.syntax, function(node) {
                        if (node.type !== 'Type' && node.type !== 'Property') {
                            return;
                        }

                        var map = node.type === 'Property' ? this.properties : this.types;

                        if (!map.hasOwnProperty(node.name) || validate.call(this, map[node.name]).broken) {
                            descriptor.broken = true;
                        }
                    }, this);
                }
            }

            return descriptor;
        }, this);

        return all.some(function(descriptor) {
            return descriptor.broken;
        });
    },
    dump: function(dontValidate) {
        if (!dontValidate) {
            this.validate();
        }

        return {
            properties: dumpMap(this.properties),
            types: dumpMap(this.types)
        };
    },
    toString: function() {
        return JSON.stringify(this.dump());
    }
};

module.exports = Syntax;
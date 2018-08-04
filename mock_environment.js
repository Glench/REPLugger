const parse_flow_src = require('flow-parser');
const flow_remove_types = require('flow-remove-types');


function prepare_current_file_to_act_as_server(file_src, names_of_interest) {
    var server_src = `console.log('server would be running here')`
    var mock_server_src = `${file_src}

/* ----- REPLUGGER MOCK SERVER ----- */

const circular_json = require('circular-json');
function replugger_json_replacer(key, value) {
    if (typeof value === 'function') {
        return typeof value //.toString();
    } 
    return value;
}
var replugger_output = {
    ${names_of_interest.map(name => `${name}: circular_json.stringify(${name}, replugger_json_replacer).slice(0, 100)`).join(',\n')}
}
process.stdout.write(circular_json.stringify(replugger_output));
process.exit();
`
    return mock_server_src;
}
module.exports.prepare_current_file_to_act_as_server = prepare_current_file_to_act_as_server;

function scopes_and_names(file_src, line_number) {
    var scopes = [];
    /* e.g.
        [
            {scope_name: 'function (evt) {',
             line_number: 102,
             names_in_scope: ['evt', 'dx', 'dy'],
             fill_in_names: ['evt'],
            }
        ]
    */

    var lines = file_src.split('\n');
    var scope_stack = [{scope_name: 'file', line_number: null, names_in_scope: []}];
    for (var i = 0; i < lines.length; ++i) {
        if (i >= line_number-1) {
            return scope_stack;
        }

        var line = lines[i].trim();
        if (line.startsWith('const ') || line.startsWith('var ')) {
            var name = line.split('=')[0].replace(/(const|var)/g, '').trim();
            scope_stack[scope_stack.length-1].names_in_scope.push(name)
        // } else if (line.startsWith('function') && scope_stack.length == 1) {
        //     // defining global function
        } else if (line.startsWith('class ') && scope_stack.length == 1) {
            var name = line.replace(/ \{.*/, '').replace('class ', '')
            scope_stack[0].names_in_scope.push(name);
        } else if (line.startsWith('function ') && scope_stack.length == 1) {
            var name = line.replace(/\(.*\) \{.*/, '').replace('function ', '');
            scope_stack[0].names_in_scope.push(name);
        } else if (line.startsWith('}')) {
            if (scope_stack.length > 1) {
                scope_stack.pop();
            }
        }
        if (line.endsWith('{')) {
            scope_stack.push({scope_name: line, line_number: i+1, names_in_scope: []})
        }
    }
}
module.exports.scopes_and_names = scopes_and_names;

function ast_to_list_of_scopes(node, scope_name, current_line_number, src, output) {
    // produce a list of scopes with variable names in each scope:
    // [
    //    {name: 'file': names_in_scope: ['module', 'clamp']},
    //    {name: 'function initialize_grid() {', names_in_scope: ['width', 'height']}]
    // ]

    var scope = {name: scope_name, names_in_scope: []}

    var nodes = null;
    if (node.type == 'Program') {
        scope.names_in_scope.push('module')
        nodes = node.body;
    } else if (node.type == 'FunctionDeclaration' || node.type == 'FunctionExpression') {
        node.params.forEach(param => scope.names_in_scope.push(param.name))
        nodes = node.body.body;
    } else if (node.type == 'BlockStatement') {
        nodes = node.body;
    } else if (node.type == 'CallExpression') {
        nodes = node.arguments; //node.arguments[node.arguments.length-1].body;
    } else if (node.type == 'IfStatement') {
        nodes = node.consequent.body;
    }

    if (!nodes) return output;


    // find declarations 
    nodes = nodes.filter(decl => decl.loc.start.line <= current_line_number);
    nodes.forEach(decl => {
        switch (decl.type) {
            case 'VariableDeclaration':
                decl.declarations.forEach(inner_decl => {
                    scope.names_in_scope.push(inner_decl.id.name)
                })
                return;
            // case 'ExpressionStatement':
            //     return;
            case 'ClassDeclaration':
                scope.names_in_scope.push(decl.id.name);
                return;
            case 'FunctionDeclaration':
            case 'FunctionExpression':
                if (decl.id) {
                    scope.names_in_scope.push(decl.id.name)
                }
                return;
        }
    })

    if (scope.names_in_scope.length > 0) {
        output.push(scope);
    }

    const last_node = nodes[nodes.length-1];
    if (!last_node) return output;
    if (last_node.loc.start.line == current_line_number && last_node.loc.end.line == current_line_number) {
        return output;
    } 

    var current_line_src = src.split('\n')[last_node.loc.start.line-1];

    if        (last_node.type == 'FunctionDeclaration' || last_node.type == 'FunctionExpression') {

        ast_to_list_of_scopes(last_node, current_line_src, current_line_number, src, output);
    } else if (last_node.type == 'ExpressionStatement') {
        ast_to_list_of_scopes(last_node.expression, current_line_src, current_line_number, src, output);
    } else if (last_node.type == 'CallExpression') {
        ast_to_list_of_scopes(last_node.arguments[last_node.arguments.length-1], current_line_src, current_line_number, src, output);
    } else if (last_node.type == 'IfStatement') {
        // find which branch of the if statement contains the current line
        var test_node = last_node;
        while (test_node.type == 'IfStatement') {
            if (test_node.consequent.loc.start.line <= current_line_number && test_node.consequent.loc.end.line >= current_line_number) {
                break
            }
            test_node = test_node.alternate;
        }
        ast_to_list_of_scopes(test_node, src.split('\n')[test_node.loc.start.line-1], current_line_number, src, output);
    } else if (last_node.type == 'FunctionExpression') {
        ast_to_list_of_scopes(last_node.body, current_line_src, current_line_number, src, output);
    } else if (last_node.type == 'BlockStatement') {
        ast_to_list_of_scopes(last_node.body, current_line_src, current_line_number, src, output);
    } else {
        // console.log('error-causing node:', last_node)
        // throw 'unhandled AST node type: '+last_node.type;
    }

    return output;
}



function ast_node_to_js(node, scopes) {
    if (!node.type) { // array of nodes
        var nodes = node;
        var output = '';
        var done = false;
        nodes.forEach(node => {
            if (done) { return; }
            if (scopes && node.loc.end.line == current_line_number && node.loc.start.line == current_line_number) {
                output += `replugger_values = {};\n${scopes.map(scope => { return scope.names_in_scope.map(name => `try { replugger_values['${name}'] = ${name} } catch(e) { replugger_values['${name}'] = '...' }`).join('\n')}).join('\n')}\n${ast_node_to_js(node, scopes)}`
                done = true;
                return 
            }
            output += ast_node_to_js(node, scopes)+'\n'
        })
        return output; 
    }
    switch (node.type) {
        case 'Program':
            return `try {
${ast_node_to_js(node.body, scopes)}
} catch (e) {
replugger_values = {};
${scopes.map(scope => { return scope.names_in_scope.map(name => `try { replugger_values['${name}'] = ${name} } catch(e) { replugger_values['${name}'] = '...' }`).join('\n')}).join('\n')}
}
`
        case 'ExpressionStatement':
            if (node.loc.start.line < current_line_number && node.loc.end.line >= current_line_number) {
                var test_node = node.expression;
                // find the part of this expression that the cursor is in
                while (test_node.type == 'CallExpression') {
                    test_node = test_node.arguments[test_node.arguments.length-1];
                }
                return `// function as argument
${ast_node_to_js(test_node, scopes)}`
            }
            return ast_node_to_js(node.expression, scopes);
        case 'ClassDeclaration':
            return `class ${ast_node_to_js(node.id, scopes)} ${ast_node_to_js(node.body, scopes)}`;
        case 'ClassProperty':
            return ``;
        case 'MethodDefinition':
            return `${ast_node_to_js(node.key, scopes)}(${node.value.params.map(param => param.name).join(', ')}) ${ast_node_to_js(node.value.body, scopes)}`;
        case 'ClassBody':
        case 'BlockStatement':
            return `{
${ast_node_to_js(node.body, scopes)}
}`
        case 'VariableDeclaration':
            var output = ''
            node.declarations.forEach((decl,i) => {
                output += ast_node_to_js(decl, scopes);
                if (i !== node.declarations.length-1) {
                    output += ',\n'
                } else {
                    output += ';'
                }
            });
            return output;
        case 'IfStatement':
            if (node.loc.start.line <= current_line_number && node.loc.end.line >= current_line_number) {
                // find which branch the cursor is in
                var test_node = node;
                while (test_node.type == 'IfStatement') {
                    if (test_node.consequent.loc.start.line <= current_line_number && test_node.consequent.loc.end.line >= current_line_number) {
                        break
                    }
                    test_node = test_node.alternate;
                }
                return `// if ${ast_node_to_js(test_node.test, scopes)}
${ast_node_to_js(test_node.consequent.body, scopes)}
`
            }
            var else_clause = '';
            if (node.alternate) {
                else_clause = `else ${ast_node_to_js(node.alternate, scopes)}`
            }

            return `if (${ast_node_to_js(node.test, scopes)}) ${ast_node_to_js(node.consequent, scopes)} ${else_clause}`;
        case 'ConditionalExpression':
            return `${ast_node_to_js(node.test, scopes)} ? ${ast_node_to_js(node.consequent, scopes)} : ${ast_node_to_js(node.alternate, scopes)}`
        case 'AssignmentExpression':
            return `${ast_node_to_js(node.left, scopes)} ${node.operator} ${ast_node_to_js(node.right, scopes)}`;
        case 'MemberExpression':
            if (node.computed) {
                return `${ast_node_to_js(node.object, scopes)}[${ast_node_to_js(node.property, scopes)}]`
            } else {
                return `${ast_node_to_js(node.object, scopes)}.${ast_node_to_js(node.property, scopes)}`
            }
        case 'VariableDeclarator':
            if (variable_overrides[current_line_number] && node.id.name in variable_overrides[current_line_number]) {
                return `var ${node.id.name} = ${variable_overrides[current_line_number][node.id.name]}`;
            }
            return `var ${node.id.name} = ${ast_node_to_js(node.init, scopes)}`;
        case 'NewExpression':
            var arguments_str = '';
            node.arguments.forEach((arg,i) => {
                arguments_str += ast_node_to_js(arg, scopes)+ (i == node.arguments.length-1 ? '' : ', ');
            })
            return `new ${ast_node_to_js(node.callee, scopes)}(${arguments_str})`;
        case 'CallExpression':
            var arguments_str = '';
            node.arguments.forEach((arg,i) => {
                arguments_str += ast_node_to_js(arg, scopes)+ (i == node.arguments.length-1 ? '' : ', ');
            })
            return `${ast_node_to_js(node.callee, scopes)}(${arguments_str})`;
        case 'FunctionExpression':
            if (node.loc.start.line <= current_line_number && node.loc.end.line >= current_line_number) {
                return `{
${node.params.map(param => `var ${param.name} = ${variable_overrides[current_line_number] ? variable_overrides[current_line_number][param.name] : 'null'};`).join('\n')}
${ast_node_to_js(node.body, scopes)}
}`
            } else {
                var params_str = '';
                node.params.forEach((param,i) => {
                    params_str += ast_node_to_js(param, scopes)+ (i == node.params.length-1 ? '' : ', ');
                })
                return `${node.async ? 'async ':''} function(${params_str}) ${ast_node_to_js(node.body, scopes)}`;
            }
        case 'FunctionDeclaration':
            if (node.loc.start.line <= current_line_number && node.loc.end.line >= current_line_number) {
                return `{ // function ${ast_node_to_js(node.id, scopes)}
${node.params.map(param => `var ${param.name} = null;`).join('\n')}
${ast_node_to_js(node.body, scopes)}
}`
            } else {
                var params_str = '';
                node.params.forEach((param,i) => {
                    params_str += ast_node_to_js(param, scopes)+ (i == node.params.length-1 ? '' : ', ');
                })
                return `${node.async ? 'async ':''}function ${ast_node_to_js(node.id, scopes)}(${params_str}) ${ast_node_to_js(node.body, scopes)}`;
            }
        case 'ArrowFunctionExpression':
            return `(${node.params.map(param => ast_node_to_js(param, scopes)).join(', ')}) => ${ast_node_to_js(node.body, scopes)}`
        case 'ForStatement':
            return `for (${ast_node_to_js(node.init, scopes)} ${ast_node_to_js(node.test, scopes)}; ${ast_node_to_js(node.update, scopes)}) ${ast_node_to_js(node.body, scopes)}`
        case 'ReturnStatement':
            return `return ${node.argument ? ast_node_to_js(node.argument, scopes) : ''};`
        case 'UnaryExpression':
            return `${node.operator} ${ast_node_to_js(node.argument, scopes)}`
        case 'BinaryExpression':
        case 'LogicalExpression':
            return `${ast_node_to_js(node.left, scopes)} ${node.operator} ${ast_node_to_js(node.right, scopes)}`;
        case 'UpdateExpression':
            if (node.prefix) {
                return `${node.operator}${ast_node_to_js(node.argument, scopes)}`;
            }
            return `${ast_node_to_js(node.argument, scopes)}${node.operator}`;
        case 'TryStatement':
            return `try ${ast_node_to_js(node.block, scopes)} ${ast_node_to_js(node.handler, scopes)}`
        case 'CatchClause':
            return `catch(${node.param.name || ''}) ${ast_node_to_js(node.body, scopes)}`
        case 'ArrayExpression':
            var output = '';
            node.elements.forEach(element => {
                output += ast_node_to_js(element, scopes);
                if (i !== node.declarations.length-1) {
                    output += ' ,\n'
                }
            })
            return `[${output}]`
        case 'ObjectExpression':
            return `{${node.properties.map(prop => ast_node_to_js(prop, scopes))}}`
        case 'Property':
            return `${ast_node_to_js(node.key, scopes)}: ${ast_node_to_js(node.value, scopes)}`
        case 'Identifier':
            return node.name;
        case 'ThisExpression':
            return 'this';
        case 'TemplateLiteral':
            return '`'+ ast_node_to_js(node.quasis, scopes) + '`'
        case 'TemplateElement':
            return node.value.raw;
        case 'Literal':
            return node.raw;
        case 'EmptyStatement':
            return ''
        default:
            console.log(node)
            return '!!!UH OH!!!'
    }
}

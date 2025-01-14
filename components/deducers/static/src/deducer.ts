import * as ts from "typescript";
import * as path from "path";
import { assert } from "console";
import { DeduceOptions, Deducer, arch } from "@plutolang/base";
import {
  ImportElement,
  ImportStore,
  ImportType,
  extractImportElements,
  genImportStats,
} from "./imports";
import { resolveImportDeps } from "./dep-resolve";

const CloudResourceType = ["Router", "Queue", "KVStore", "Schedule"];

export class StaticDeducer implements Deducer {
  public async deduce(opts: DeduceOptions): Promise<arch.Architecture> {
    const { filepaths } = opts;
    if (filepaths.length == 0) {
      throw new Error("The filepaths is empty.");
    }

    const tsconfigPath = path.resolve("./", "tsconfig.json");
    const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
    const configJson = ts.parseJsonConfigFileContent(configFile.config, ts.sys, "./");
    return await compilePluto(filepaths, configJson.options);
  }
}

async function compilePluto(
  fileNames: string[],
  options: ts.CompilerOptions
): Promise<arch.Architecture> {
  const archRef = new arch.Architecture();
  const root = new arch.Resource("App", "Root"); // Resource Root
  archRef.addResource(root);

  const program = ts.createProgram(fileNames, options);
  const allDiagnostics = ts.getPreEmitDiagnostics(program);
  // Emit errors
  allDiagnostics.forEach((diagnostic) => {
    if (diagnostic.file) {
      const { line, character } = ts.getLineAndCharacterOfPosition(
        diagnostic.file,
        diagnostic.start!
      );
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
      console.log(`${diagnostic.file.fileName} (${line + 1},${character + 1}): ${message}`);
    } else {
      console.log(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
    }
  });
  const sourceFile = program.getSourceFile(fileNames[0])!;
  const checker = program.getTypeChecker();
  // To print the AST, we'll use TypeScript's printer
  let handlerIndex = 1;

  const importStore: ImportStore = new ImportStore();
  // Loop through the root AST nodes of the file
  ts.forEachChild(sourceFile, (node) => {
    if (ts.isImportDeclaration(node)) {
      importStore.update(extractImportElements(sourceFile, node));
      return;
    }

    // VariableStatement: Maybe IaC Definition
    if (ts.isVariableStatement(node)) {
      if (
        node.declarationList.declarations[0].initializer &&
        ts.isNewExpression(node.declarationList.declarations[0].initializer)
      ) {
        // TODO: declarations.forEach()
        const newExpr = node.declarationList.declarations[0].initializer;
        const variable = node.declarationList.declarations[0].name;
        const varName = variable.getText(sourceFile);
        const symbol = checker.getSymbolAtLocation(newExpr.expression);
        // TODO: use `ts.factory.createIdentifier("factorial")` to replace.
        if (symbol) {
          // TODO: use decorator mapping on SDK? The SDK auto workflow
          const ty = checker.getTypeOfSymbol(symbol);
          const resType = ty.symbol.escapedName.toString();
          const param1 = newExpr.arguments![0].getText();
          if (process.env.DEBUG) {
            console.log(`Found a ${resType}: ${varName}`);
          }

          // Get the dependency of this class
          const initFn = newExpr.expression.getText(sourceFile);
          const elemName = initFn.split(".")[0];
          const elem = importStore.searchElement(elemName);
          if (elem == undefined) {
            throw new Error(`Cannot find the element for ${elemName}`);
          }

          const startPos = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          const endPos = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
          const loc: arch.Location = {
            file: fileNames[0],
            linenum: {
              start: `${startPos.line}-${startPos.character}`,
              end: `${endPos.line}-${endPos.character}`,
            },
          };
          const param: arch.Parameter = { index: 0, name: "name", value: param1 };
          const newRes = new arch.Resource(varName, resType, [loc], [param]);
          // TODO: get additional dependencies in the parameters.
          newRes.addImports(...genImportStats([elem]));
          const relat = new arch.Relationship(root, newRes, arch.RelatType.CREATE, "new");
          archRef.addResource(newRes);
          archRef.addRelationship(relat);
        }
      }
    }
    // ExpressionStatement: Maybe FaaS router handler
    // lookup `router.get()` form
    if (
      ts.isExpressionStatement(node) &&
      ts.isCallExpression(node.expression) &&
      ts.isPropertyAccessExpression(node.expression.expression)
    ) {
      const symbol = checker.getSymbolAtLocation(node.expression.expression.expression);
      if (symbol) {
        const ty = checker.getTypeOfSymbol(symbol);
        const className = ty.symbol.escapedName.toString();
        // TODO: use router Type
        if (["Router", "Queue", "Schedule"].indexOf(className) !== -1) {
          const objName = symbol.escapedName;
          const op = node.expression.expression.name.getText();

          // Check each argument and create a Lambda resource if the argument is a function.
          const iacArgs: arch.Parameter[] = [];
          const resources = [];
          for (let argIdx = 0; argIdx < node.expression.arguments.length; argIdx++) {
            const arg = node.expression.arguments[argIdx];
            if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
              const fnName = `lambda${handlerIndex}`;
              const resType = "FnResource";
              if (process.env.DEBUG) {
                console.log("Found a FnResource: " + fnName);
              }

              const startPos = sourceFile.getLineAndCharacterOfPosition(arg.getStart(sourceFile));
              const endPos = sourceFile.getLineAndCharacterOfPosition(arg.getEnd());
              const loc: arch.Location = {
                file: fileNames[0],
                linenum: {
                  start: `${startPos.line}-${startPos.character}`,
                  end: `${endPos.line}-${endPos.character}`,
                },
              };
              const param: arch.Parameter = {
                index: 0,
                name: "name",
                value: `"lambda${handlerIndex}"`,
              };
              const newRes = new arch.Resource(fnName, resType, [loc], [param]);
              archRef.addResource(newRes);
              resources.push(newRes);

              // Constructs the import statments of this function
              const deps: ImportElement[] = resolveImportDeps(sourceFile, importStore, arg);
              const importStats = genImportStats(deps);
              if (process.env.DEBUG) {
                console.log(`Generate ${importStats.length} import statments: `);
                console.log(importStats.join("\n"));
              }
              newRes.addImports(...importStats);

              detectPermission(archRef, fnName, arg, checker);

              // TODO: get the parameter name
              iacArgs.push({ index: argIdx, name: "fn", value: fnName });
              handlerIndex++;
            } else {
              iacArgs.push({ index: argIdx, name: "path", value: arg.getText() });
            }
          }

          if (resources.length > 0) {
            const parRes = archRef.getResource(objName.toString());
            resources.forEach((res) => {
              const relat = new arch.Relationship(parRes, res, arch.RelatType.CREATE, op, iacArgs);
              archRef.addRelationship(relat);
            });
          }
        }
      }
    }
  });

  // Add direct import statment to Root
  const elems = importStore.listAllElementsByType(ImportType.Direct);
  root.addImports(...genImportStats(elems));
  return archRef;
}

function detectPermission(
  archRef: arch.Architecture,
  fnName: string,
  fnNode: ts.Expression,
  tyChecker: ts.TypeChecker
) {
  const checkPermission = (node: ts.Node) => {
    let propAccessExp;
    // Write operation, e.g. state.set(), queue.push()
    if (
      ts.isExpressionStatement(node) &&
      ts.isAwaitExpression(node.expression) &&
      ts.isCallExpression(node.expression.expression) &&
      ts.isPropertyAccessExpression(node.expression.expression.expression)
    ) {
      propAccessExp = node.expression.expression.expression;
    } else if (ts.isVariableStatement(node)) {
      // Read operation, e.g. state.get()
      const initExp = node.declarationList.declarations[0].initializer;
      if (
        initExp &&
        ts.isAwaitExpression(initExp) &&
        ts.isCallExpression(initExp.expression) &&
        ts.isPropertyAccessExpression(initExp.expression.expression)
      ) {
        propAccessExp = initExp.expression.expression;
      }
    }

    // fetch permission
    if (propAccessExp) {
      const objSymbol = tyChecker.getSymbolAtLocation(propAccessExp.expression);
      if (!objSymbol) {
        return;
      }

      const typ = tyChecker.getTypeOfSymbol(objSymbol);
      if (CloudResourceType.indexOf(typ.symbol.escapedName.toString()) == -1) {
        return;
      }
      const opSymbol = tyChecker.getSymbolAtLocation(propAccessExp);
      assert(opSymbol, "Op Symbol is undefined");

      const resName = objSymbol!.escapedName.toString();
      const opName = opSymbol!.escapedName.toString();

      const fromRes = archRef.getResource(fnName);
      const toRes = archRef.getResource(resName);
      const relat = new arch.Relationship(fromRes, toRes, arch.RelatType.ACCESS, opName);
      archRef.addRelationship(relat);
    }
  };

  const fnBody = fnNode.getChildAt(fnNode.getChildCount() - 1);
  fnBody.forEachChild(checkPermission);
}

import {
  createConnection,
  TextDocuments,
  Diagnostic,
  DiagnosticSeverity,
  ProposedFeatures,
  InitializeParams,
  DidChangeConfigurationNotification,
  CompletionItem,
  CompletionItemKind,
  TextDocumentPositionParams,
  TextDocumentSyncKind,
  InitializeResult,
  DidCloseTextDocumentParams,
  DefinitionParams,
  DeclarationLink,
  Position,
  LocationLink,
  TypeDefinitionParams,
} from "vscode-languageserver/node";

import { TextDocument } from "vscode-languageserver-textdocument";
import { parse, validate } from "@apexlang/core";
import {
  AliasDefinition,
  Definition,
  EnumDefinition,
  Kind,
  Location,
  Name,
  Node,
  TypeDefinition,
  UnionDefinition,
} from "@apexlang/core/ast";
import { CommonRules } from "@apexlang/core/rules";
import { ApexError } from "@apexlang/core/error";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";

// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager.
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

const documentCompletions: Map<string, CompletionItem[]> = new Map<
  string,
  CompletionItem[]
>();

const documentDefinitions: Map<string, Definition[]> = new Map<
  string,
  Definition[]
>();

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;
let hasDiagnosticRelatedInformationCapability = false;

connection.onInitialize((params: InitializeParams) => {
  const capabilities = params.capabilities;

  // Does the client support the `workspace/configuration` request?
  // If not, we fall back using global settings.
  hasConfigurationCapability = !!(
    capabilities.workspace && !!capabilities.workspace.configuration
  );
  hasWorkspaceFolderCapability = !!(
    capabilities.workspace && !!capabilities.workspace.workspaceFolders
  );
  hasDiagnosticRelatedInformationCapability = !!(
    capabilities.textDocument &&
    capabilities.textDocument.publishDiagnostics &&
    capabilities.textDocument.publishDiagnostics.relatedInformation
  );

  const result: InitializeResult = {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      // Tell the client that this server supports code completion.
      completionProvider: {
        resolveProvider: true,
      },
      definitionProvider: true,
      typeDefinitionProvider: true,
    },
  };
  if (hasWorkspaceFolderCapability) {
    result.capabilities.workspace = {
      workspaceFolders: {
        supported: true,
      },
    };
  }
  return result;
});

connection.onInitialized(() => {
  if (hasConfigurationCapability) {
    // Register for all configuration changes.
    connection.client.register(
      DidChangeConfigurationNotification.type,
      undefined
    );
  }
  if (hasWorkspaceFolderCapability) {
    connection.workspace.onDidChangeWorkspaceFolders((_event) => {
      connection.console.log("Workspace folder change event received.");
    });
  }
});

// The Apex settings
interface ApexSettings {
  maxNumberOfProblems: number;
}

// The global settings, used when the `workspace/configuration` request is not supported by the client.
// Please note that this is not the case when using this server with the client provided in this example
// but could happen with other clients.
const defaultSettings: ApexSettings = { maxNumberOfProblems: 1000 };
let globalSettings: ApexSettings = defaultSettings;

// Cache the settings of all open documents
const documentSettings: Map<string, Thenable<ApexSettings>> = new Map();

connection.onDidChangeConfiguration((change) => {
  if (hasConfigurationCapability) {
    // Reset all cached document settings
    documentSettings.clear();
  } else {
    globalSettings = <ApexSettings>(
      (change.settings.apexlang || defaultSettings)
    );
  }

  // Revalidate all open text documents
  documents.all().forEach(validateTextDocument);
});

function getDocumentSettings(resource: string): Thenable<ApexSettings> {
  if (!hasConfigurationCapability) {
    return Promise.resolve(globalSettings);
  }
  let result = documentSettings.get(resource);
  if (!result) {
    result = connection.workspace.getConfiguration({
      scopeUri: resource,
      section: "apexlang",
    });
    documentSettings.set(resource, result);
  }
  return result;
}

// Only keep settings for open documents
documents.onDidClose((e) => {
  documentSettings.delete(e.document.uri);
});

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent((change) => {
  validateTextDocument(change.document);
});

const home = os.homedir();
const definitionsDir = path.join(home, ".apex", "definitions");

function resolver(location: string, _from: string): string {
  let loc = path.join(definitionsDir, ...location.split("/"));
  if (!loc.endsWith(".apex")) {
    const apexLoc = loc + ".apex";
    try {
      const stats = fs.statSync(apexLoc);
      if (stats.isFile()) {
        return fs.readFileSync(apexLoc).toString();
      }
    } catch (_) {
      // Do nothing.
    }
    const stats = fs.statSync(loc);
    if (!stats.isFile()) {
      if (stats.isDirectory()) {
        loc = path.join(loc, "index.apex");
      } else {
        loc += ".apex";
      }
    }
  }
  return fs.readFileSync(loc).toString();
}

async function validateTextDocument(textDocument: TextDocument): Promise<void> {
  // In this simple example we get the settings for every validate run.
  const settings = await getDocumentSettings(textDocument.uri);

  const text = textDocument.getText();
  const diagnostics: Diagnostic[] = [];

  try {
    const doc = parse(text, resolver);

    const completionItems = new Array<CompletionItem>();
    doc.definitions.map((def, i) => {
      if (def.isKind(Kind.TypeDefinition)) {
        const type = def as TypeDefinition;
        completionItems.push({
          label: type.name.value,
          kind: CompletionItemKind.Struct,
        });
      } else if (def.isKind(Kind.EnumDefinition)) {
        const enumDef = def as EnumDefinition;
        completionItems.push({
          label: enumDef.name.value,
          kind: CompletionItemKind.Enum,
        });
        enumDef.values.map((ev) => {
          completionItems.push({
            label: ev.name.value,
            kind: CompletionItemKind.EnumMember,
          });
        });
      } else if (def.isKind(Kind.UnionDefinition)) {
        const unionDef = def as UnionDefinition;
        completionItems.push({
          label: unionDef.name.value,
          kind: CompletionItemKind.Struct,
        });
      }
    });
    documentCompletions.set(textDocument.uri, completionItems);
    documentDefinitions.set(textDocument.uri, doc.definitions);

    const errors = validate(doc, ...CommonRules);

    let problems = 0;

    errors.map((e) => {
      const node = e.nodes as Node;
      const loc = node.getLoc() as Location;
      problems++;
      const diagnostic: Diagnostic = {
        severity: DiagnosticSeverity.Error,
        range: {
          start: textDocument.positionAt(loc.start),
          end: textDocument.positionAt(loc.end),
        },
        message: e.message,
      };
      diagnostics.push(diagnostic);

      return problems < settings.maxNumberOfProblems;
    });
  } catch (e) {
    const we = e as ApexError;
    if (we.nodes != undefined) {
      const node = we.nodes as Node;
      const loc = node.getLoc()!;
      if (loc != undefined) {
        const diagnostic: Diagnostic = {
          severity: DiagnosticSeverity.Error,
          range: {
            start: textDocument.positionAt(loc.start),
            end: textDocument.positionAt(loc.end),
          },
          message: we.message,
        };
        diagnostics.push(diagnostic);
      }
    } else if (we.positions != undefined) {
      const pos = we.positions[0];
      const diagnostic: Diagnostic = {
        severity: DiagnosticSeverity.Error,
        range: {
          start: textDocument.positionAt(pos),
          end: textDocument.positionAt(pos),
        },
        message: we.message,
      };
      diagnostics.push(diagnostic);
    }
  }

  // Send the computed diagnostics to VSCode.
  connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
}

connection.onDidChangeWatchedFiles((_change) => {
  // Monitored files have change in VSCode
  //connection.console.log("We received an file change event");
});

// This handler provides the initial list of the completion items.
connection.onCompletion(
  (textDocumentPosition: TextDocumentPositionParams): CompletionItem[] => {
    // The pass parameter contains the position of the text document in
    // which code complete got requested. For the example we ignore this
    // info and always provide the same completion items.
    const completions = documentCompletions.get(
      textDocumentPosition.textDocument.uri
    );
    return completions || [];
  }
);

interface NamedDefinition extends Definition {
  name: Name;
}

connection.onTypeDefinition(
  (definition: TypeDefinitionParams): DeclarationLink[] => {
    console.log("onTypeDefinition", definition.textDocument.uri);
    const txtDoc = documents.get(definition.textDocument.uri);
    if (txtDoc == undefined) {
      return [];
    }
    const definitions = documentDefinitions.get(definition.textDocument.uri);
    if (definitions == undefined) {
      return [];
    }

    const symbol = getSymbolAtPosition(txtDoc, definition.position);

    return filterDefinitions(txtDoc, definitions, symbol);
  }
);

connection.onDefinition((definition: DefinitionParams): DeclarationLink[] => {
  console.log("onDefinition", definition.textDocument.uri);
  const txtDoc = documents.get(definition.textDocument.uri);
  if (txtDoc == undefined) {
    return [];
  }
  const definitions = documentDefinitions.get(definition.textDocument.uri);
  if (definitions == undefined) {
    return [];
  }

  const symbol = getSymbolAtPosition(txtDoc, definition.position);

  return filterDefinitions(txtDoc, definitions, symbol);
});

function filterDefinitions(
  txtDoc: TextDocument,
  definitions: Definition[],
  symbol: string
): DeclarationLink[] {
  return definitions
    .filter((def) => {
      const named = def as NamedDefinition;
      switch (def.getKind()) {
        case Kind.AliasDefinition:
        case Kind.DirectiveDefinition:
        case Kind.EnumDefinition:
        case Kind.EnumValueDefinition:
        case Kind.RoleDefinition:
        case Kind.UnionDefinition:
        case Kind.TypeDefinition:
          return named.name != undefined && named.name.value == symbol;
        default:
          return false;
      }
    })
    .map((def) => {
      const named = def as NamedDefinition;
      const loc = named.name.getLoc() as Location;
      return LocationLink.create(
        txtDoc.uri,
        {
          start: txtDoc.positionAt(loc.start),
          end: txtDoc.positionAt(loc.end),
        },
        {
          start: txtDoc.positionAt(loc.start),
          end: txtDoc.positionAt(loc.end),
        }
      );
    });
}

const tokenSeparators = /[\t= <>{}()"]/;

function getSymbolAtPosition(txtDoc: TextDocument, position: Position): string {
  const range = {
    start: { line: position.line, character: 0 },
    end: { line: position.line, character: Number.MAX_VALUE },
  };

  const context = txtDoc.getText(range);
  const offset = position.character;

  let start = offset - 1;
  while (start > 0 && !context[start].match(tokenSeparators)) {
    start--;
  }

  let end = offset;
  while (end < context.length && !context[end].match(tokenSeparators)) {
    end++;
  }

  const symbol = context.substr(start + 1, end - start - 1);
  console.log(`${start}->${end}- symbol: ${symbol}`);

  return symbol;
}

connection.onDidCloseTextDocument(
  (didCloseTextDocument: DidCloseTextDocumentParams) => {
    documentCompletions.delete(didCloseTextDocument.textDocument.uri);
  }
);

// This handler resolves additional information for the item selected in
// the completion list.
connection.onCompletionResolve((item: CompletionItem): CompletionItem => {
  return item;
});

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();

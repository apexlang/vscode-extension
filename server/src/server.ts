/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
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
} from "vscode-languageserver/node";

import { TextDocument } from "vscode-languageserver-textdocument";
import { parse, validate } from "@wapc/widl";
import {
  EnumDefinition,
  Kind,
  Location,
  Node,
  TypeDefinition,
  UnionDefinition,
} from "@wapc/widl/ast";
import { CommonRules } from "@wapc/widl/rules";
import { WidlError } from "@wapc/widl/error";
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

// The WIDL settings
interface WIDLSettings {
  maxNumberOfProblems: number;
}

// The global settings, used when the `workspace/configuration` request is not supported by the client.
// Please note that this is not the case when using this server with the client provided in this example
// but could happen with other clients.
const defaultSettings: WIDLSettings = { maxNumberOfProblems: 1000 };
let globalSettings: WIDLSettings = defaultSettings;

// Cache the settings of all open documents
const documentSettings: Map<string, Thenable<WIDLSettings>> = new Map();

connection.onDidChangeConfiguration((change) => {
  if (hasConfigurationCapability) {
    // Reset all cached document settings
    documentSettings.clear();
  } else {
    globalSettings = <WIDLSettings>(
      (change.settings.widl || defaultSettings)
    );
  }

  // Revalidate all open text documents
  documents.all().forEach(validateTextDocument);
});

function getDocumentSettings(resource: string): Thenable<WIDLSettings> {
  if (!hasConfigurationCapability) {
    return Promise.resolve(globalSettings);
  }
  let result = documentSettings.get(resource);
  if (!result) {
    result = connection.workspace.getConfiguration({
      scopeUri: resource,
      section: "widl",
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
const definitionsDir = path.join(home, ".wapc", "definitions");

function resolver(location: string, _from: string): string {
  let loc = path.join(definitionsDir, ...location.split("/"));
  if (!loc.endsWith(".widl")) {
    const widlLoc = loc + ".widl";
    let found = false;
    try {
      const stats = fs.statSync(widlLoc);
      found = stats.isFile();
    } catch (_) {
      found = false; // Make linter happy
    }
    if (!found) {
      const stats = fs.statSync(loc);
      if (!stats.isFile()) {
        if (stats.isDirectory()) {
          loc = path.join(loc, "index.widl");
        } else {
          loc += ".widl";
        }
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
    const we = e as WidlError;
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
  connection.console.log("We received an file change event");
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

connection.onDidCloseTextDocument(
  (didCloseTextDocument: DidCloseTextDocumentParams) => {
    documentCompletions.delete(didCloseTextDocument.textDocument.uri);
  }
);

// This handler resolves additional information for the item selected in
// the completion list.
connection.onCompletionResolve(
  (item: CompletionItem): CompletionItem => {
    return item;
  }
);

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();

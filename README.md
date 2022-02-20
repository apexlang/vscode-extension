# VS Code extension for the Apex language

Extension for editing Apex Interface Defintion Language (IDL) documents inside VS Code.  

## Functionality

This Language Server works for plain text file. It has the following language features:
- Completions
- Diagnostics regenerated on each file change or configuration change

## Running the Project

- Run `npm install` in this folder. This installs all necessary npm modules in both the client and server folder
- Open VS Code on this folder.
- Press Ctrl+Shift+B to compile the client and server.
- Switch to the Debug viewlet.
- Select `Launch Client` from the drop down.
- Run the launch config.
- If you want to debug the server as well use the launch configuration `Attach to Server`
- In the [Extension Development Host] instance of VSCode, open a document in 'Apex' language mode.

## Packaging & Installing

- Run `vsce package` to generate `apexlang-vscode-extension-{semver}.vsix`.
- Install the `.vsix` file in VS Code using the `Install from VSIX...` option under the `Extensions` view (three dots dropdown).

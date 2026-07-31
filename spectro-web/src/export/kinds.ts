// The one word that says which tab an export was taken from.
//
// It lives in its own module rather than beside the menu that produces it: the
// renderers and the option model both need it, and a type imported from a .tsx
// component would drag React into modules that are pure string work — and pull
// the component into the cycle the moment it imports them back.

/** The view an export was taken from. It names the file and leads the document. */
export type ExportKind = "chat" | "text";

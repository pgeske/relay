// Bun embeds files imported `with { type: "text" }` into the compiled binary as strings.
declare module "*.conf" {
  const content: string;
  export default content;
}

// files bundled as text (`import x from './a.sh' with { type: 'text' }`)
declare module '*.sh' {
  const text: string
  export default text
}
declare module '*.ps1' {
  const text: string
  export default text
}

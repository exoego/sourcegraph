import * as sourcegraph from 'sourcegraph'
import { isDefined } from '../../../../shared/src/util/types'
import { combineLatestOrDefault } from '../../../../shared/src/util/rxjs/combineLatestOrDefault'
import { flatten, sortedUniq, sortBy } from 'lodash'
import { Subscription, Observable, of, Unsubscribable, from, combineLatest } from 'rxjs'
import { map, switchMap, startWith, first, toArray } from 'rxjs/operators'
import { queryGraphQL, settingsObservable, memoizedFindTextInFiles } from './util'
import * as GQL from '../../../../shared/src/graphql/schema'
import { OTHER_CODE_ACTIONS, MAX_RESULTS, REPO_INCLUDE } from './misc'

export function registerDependencyRules(): Unsubscribable {
    const subscriptions = new Subscription()
    subscriptions.add(startDiagnostics())
    subscriptions.add(
        sourcegraph.status.registerStatusProvider('npm-dependency-security', createStatusProvider(diagnostics))
    )
    subscriptions.add(sourcegraph.languages.registerCodeActionProvider(['*'], createCodeActionProvider()))
    return subscriptions
}

interface Settings {
    ['dependency.rules']?: {
        npm?: { [name: string]: DependencyStatus }
    }
}

enum DependencyStatus {
    Allowed = 'allow',
    Forbidden = 'forbid',
    Unreviewed = 'unreviewed',
}

const CODE_DEPENDENCY_RULES = 'DEPENDENCY_RULES'

function startDiagnostics(): Unsubscribable {
    const subscriptions = new Subscription()

    const diagnosticsCollection = sourcegraph.languages.createDiagnosticCollection('dependencyRules')
    subscriptions.add(diagnosticsCollection)
    subscriptions.add(
        diagnostics.subscribe(entries => {
            diagnosticsCollection.set(entries)
        })
    )

    return diagnosticsCollection
}

function createStatusProvider(diagnostics: Observable<[URL, sourcegraph.Diagnostic[]][]>): sourcegraph.StatusProvider {
    const LOADING: 'loading' = 'loading'
    return {
        provideStatus: (scope): sourcegraph.Subscribable<sourcegraph.Status | null> => {
            // TODO!(sqs): dont ignore scope
            return combineLatest([diagnostics.pipe(startWith(LOADING)), settingsObservable<Settings>()]).pipe(
                map(([diagnostics, settings]) => {
                    const deps = new Map<string, DependencyStatus>()
                    if (diagnostics !== LOADING) {
                        for (const [, diags] of diagnostics) {
                            for (const diag of diags) {
                                const dep = getDiagnosticData(diag)
                                const depStatus = getDependencyStatusFromSettings(settings, dep)
                                deps.set(dep.name, depStatus)
                            }
                        }
                    }

                    const status: sourcegraph.Status = {
                        title: 'npm dependency security',
                        description: {
                            kind: sourcegraph.MarkupKind.Markdown,
                            value: 'Monitors and enforces rules about the use of npm dependencies.',
                        },
                        state:
                            diagnostics === LOADING
                                ? {
                                      completion: sourcegraph.StatusCompletion.InProgress,
                                      message: 'Scanning npm dependencies...',
                                  }
                                : {
                                      completion: sourcegraph.StatusCompletion.Completed,
                                      result:
                                          diagnostics.length > 0
                                              ? sourcegraph.StatusResult.Failure
                                              : sourcegraph.StatusResult.Success,
                                      message:
                                          diagnostics.length > 0
                                              ? 'Unapproved npm dependencies found'
                                              : 'All in-use npm dependencies are approved',
                                  },
                        sections: {
                            settings: {
                                kind: sourcegraph.MarkupKind.Markdown,
                                value: `Require explicit approval for all npm dependencies`,
                            },
                            notifications: {
                                kind: sourcegraph.MarkupKind.Markdown,
                                value: `Fail changesets that add unapproved npm dependencies`,
                            },
                        },
                        notifications: sortBy(Array.from(deps.entries()), 0)
                            .filter(([, depStatus]) => depStatus !== DependencyStatus.Allowed)
                            .map<sourcegraph.Notification>(([depName, depStatus]) => ({
                                title:
                                    depStatus === DependencyStatus.Unreviewed
                                        ? `Unreviewed npm dependency in use: ${depName}`
                                        : `Forbidden npm dependency in use: ${depName}`,
                                type:
                                    depStatus === DependencyStatus.Unreviewed
                                        ? sourcegraph.NotificationType.Warning
                                        : sourcegraph.NotificationType.Error,
                            })),
                    }
                    return status
                })
            )
        },
    }
}

function createCodeActionProvider(): sourcegraph.CodeActionProvider {
    return {
        provideCodeActions: (doc, _rangeOrSelection, context): Observable<sourcegraph.CodeAction[]> => {
            const diag = context.diagnostics.find(isDependencyRulesDiagnostic)
            if (!diag) {
                return of([])
            }
            const dep = getDiagnosticData(diag)
            return from(settingsObservable<Settings>()).pipe(
                map(settings => {
                    const status = getDependencyStatusFromSettings(settings, dep)
                    if (status === DependencyStatus.Allowed) {
                        return []
                    }
                    return [
                        ...(status === DependencyStatus.Forbidden
                            ? [
                                  {
                                      title: `Remove dependency from package.json (further edits required)`,
                                      edit: computeRemoveDependencyEdit(diag, doc),
                                      diagnostics: [diag],
                                  },
                              ]
                            : []),
                        {
                            title: `Allow dependency in this repository`,
                            command: updateDependencyRulesCommand(DependencyStatus.Allowed, dep),
                            diagnostics: [diag],
                        },
                        {
                            // TODO!(sqs): globally is not implemented
                            title: `Allow dependency globally`,
                            command: updateDependencyRulesCommand(DependencyStatus.Allowed, dep),
                            diagnostics: [diag],
                        },
                        ...(status === DependencyStatus.Unreviewed
                            ? [
                                  {
                                      title: `Forbid dependency in this repository`,
                                      command: updateDependencyRulesCommand(DependencyStatus.Forbidden, dep),
                                      diagnostics: [diag],
                                  },
                                  {
                                      // TODO!(sqs): globally is not implemented
                                      title: `Forbid dependency globally`,
                                      command: updateDependencyRulesCommand(DependencyStatus.Forbidden, dep),
                                      diagnostics: [diag],
                                  },
                              ]
                            : []),
                        {
                            title: `View npm package: ${dep.name}`,
                            command: { title: '', command: 'TODO!(sqs)' },
                        },
                        ...OTHER_CODE_ACTIONS,
                    ].filter(isDefined)
                })
            )
        },
    }
}

const diagnostics: Observable<[URL, sourcegraph.Diagnostic[]][]> = from(sourcegraph.workspace.rootChanges).pipe(
    startWith(void 0),
    map(() => sourcegraph.workspace.roots),
    switchMap(async roots => {
        if (roots.length > 0) {
            return of([]) // TODO!(sqs): dont run in comparison mode
        }

        const results = flatten(
            await from(
                memoizedFindTextInFiles(
                    { pattern: '[Dd]ependencies"', type: 'regexp' },
                    {
                        repositories: {
                            includes: [REPO_INCLUDE],
                            excludes: ['hackathon'],
                            type: 'regexp',
                        },
                        files: {
                            includes: ['(^|/)package.json$'],
                            type: 'regexp',
                        },
                        maxResults: MAX_RESULTS,
                    }
                )
            )
                .pipe(toArray())
                .toPromise()
        )
        const docs = await Promise.all(
            results.map(async ({ uri }) => sourcegraph.workspace.openTextDocument(new URL(uri)))
        )
        return from(settingsObservable<Settings>()).pipe(
            map(settings =>
                docs
                    .map(({ uri, text }) => {
                        const diagnostics: sourcegraph.Diagnostic[] = parseDependencies(text)
                            .map(({ range, ...dep }) => {
                                const status = getDependencyStatusFromSettings(settings, dep)
                                if (status === DependencyStatus.Allowed) {
                                    return null
                                }
                                return {
                                    message: `${
                                        status === DependencyStatus.Forbidden ? 'Forbidden' : 'Unreviewed'
                                    } npm dependency '${dep.name}'`,
                                    range: range,
                                    severity:
                                        status === DependencyStatus.Forbidden
                                            ? sourcegraph.DiagnosticSeverity.Error
                                            : sourcegraph.DiagnosticSeverity.Warning,
                                    code: CODE_DEPENDENCY_RULES + ':' + JSON.stringify(dep),
                                } as sourcegraph.Diagnostic
                            })
                            .filter(isDefined)
                        return diagnostics.length > 0
                            ? ([new URL(uri), diagnostics] as [URL, sourcegraph.Diagnostic[]])
                            : null
                    })
                    .filter(isDefined)
            )
        )
    }),
    switchMap(results => results)
)

interface Dependency {
    name: string
}

/**
 * Parses and returns all dependencies from a package.json file.
 */
function parseDependencies(text: string): (Dependency & { range: sourcegraph.Range })[] {
    try {
        const data = JSON.parse(text)
        const depNames = sortedUniq([
            ...Object.keys(data.dependencies || {}),
            ...Object.keys(data.devDependencies || {}),
            ...Object.keys(data.peerDependencies || {}),
        ])
        return depNames.map(name => ({ name, range: findDependencyMatchRange(text, name) }))
    } catch (err) {
        // TODO!(sqs): better error handling
        console.error('Error parsing package.json:', err)
        return []
    }
}

function findDependencyMatchRange(text: string, depName: string): sourcegraph.Range {
    for (const [i, line] of text.split('\n').entries()) {
        const pat = new RegExp(`"${depName}"`, 'g')
        const match = pat.exec(line)
        if (match) {
            return new sourcegraph.Range(i, match.index, i, match.index + match[0].length)
        }
    }
    throw new Error(`dependency ${depName} not found in package.json`)
}

function getDependencyStatusFromSettings(settings: Settings, dep: Dependency): DependencyStatus {
    return (
        (settings['dependency.rules'] &&
            settings['dependency.rules'].npm &&
            settings['dependency.rules'].npm[dep.name]) ||
        DependencyStatus.Unreviewed
    )
}

function isDependencyRulesDiagnostic(diag: sourcegraph.Diagnostic): boolean {
    return typeof diag.code === 'string' && diag.code.startsWith(CODE_DEPENDENCY_RULES + ':')
}

function getDiagnosticData(diag: sourcegraph.Diagnostic): Dependency {
    return JSON.parse((diag.code as string).slice((CODE_DEPENDENCY_RULES + ':').length))
}

function computeRemoveDependencyEdit(
    diag: sourcegraph.Diagnostic,
    doc: sourcegraph.TextDocument,
    edit = new sourcegraph.WorkspaceEdit()
): sourcegraph.WorkspaceEdit {
    const dep = getDiagnosticData(diag)
    const range = findDependencyMatchRange(doc.text, dep.name)
    // TODO!(sqs): assumes dependency key-value is all on one line and only appears once
    edit.delete(
        new URL(doc.uri),
        new sourcegraph.Range(
            range.start.with({ character: 0 }),
            range.end.with({ line: range.end.line + 1, character: 0 })
        )
    )
    return edit
}

/**
 * Returns the object describing how to invoke the command to update dependency rules for the given
 * {@link dep} and {@link status}.
 */
function updateDependencyRulesCommand(
    status: DependencyStatus.Allowed | DependencyStatus.Forbidden,
    dep: Pick<Dependency, 'name'>
): sourcegraph.Command {
    return { title: '', command: 'updateConfiguration', arguments: [['dependency.rules', 'npm', dep.name], status] }
}

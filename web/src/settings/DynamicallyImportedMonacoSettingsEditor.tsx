import { LoadingSpinner } from '@sourcegraph/react-loading-spinner'
import * as H from 'history'
import * as _monaco from 'monaco-editor' // type only
import * as React from 'react'
import { Subscription } from 'rxjs'
import { SaveToolbar } from '../components/SaveToolbar'
import * as _monacoSettingsEditorModule from '../settings/MonacoSettingsEditor' // type only
import { EditorAction } from '../site-admin/configHelpers'
import { ThemeProps } from '../theme'

/**
 * Converts a Monaco/vscode style Disposable object to a simple function that can be added to a rxjs Subscription
 */
const disposableToFn = (disposable: _monaco.IDisposable) => () => disposable.dispose()

interface Props
    extends Pick<_monacoSettingsEditorModule.Props, 'id' | 'readOnly' | 'height' | 'jsonSchema' | 'language'>,
        ThemeProps {
    value: string

    actions?: EditorAction[]

    loading?: boolean
    saving?: boolean

    canEdit?: boolean

    className?: string

    onSave?: (value: string) => void
    onChange?: (value: string) => void
    onDirtyChange?: (dirty: boolean) => void
    history: H.History
}

interface State {
    /** The current contents of the editor, if changed from Props.value. */
    value?: string
}

const MonacoSettingsEditor = React.lazy(async () => ({
    default: (await import('../settings/MonacoSettingsEditor')).MonacoSettingsEditor,
}))

/** Displays a MonacoSettingsEditor component without loading Monaco in the current Webpack chunk. */
export class DynamicallyImportedMonacoSettingsEditor extends React.PureComponent<Props, State> {
    public state: State = {}

    private subscriptions = new Subscription()

    private monaco: typeof _monaco | null = null
    private configEditor?: _monaco.editor.ICodeEditor

    public componentDidMount(): void {
        // Prevent navigation when dirty.
        this.subscriptions.add(
            this.props.history.block((location: H.Location, action: H.Action) => {
                if (action === 'REPLACE') {
                    return undefined
                }
                if (this.props.loading || this.isDirty) {
                    return 'Discard changes?'
                }
                return undefined // allow navigation
            })
        )
    }

    public componentWillUnmount(): void {
        this.subscriptions.unsubscribe()
    }

    private get effectiveValue(): string {
        return this.state.value === undefined ? this.props.value : this.state.value
    }

    private get isDirty(): boolean {
        return this.effectiveValue !== this.props.value
    }

    public render(): JSX.Element | null {
        const isDirty = this.isDirty
        const effectiveValue = this.effectiveValue
        return (
            <div className={this.props.className || ''}>
                {this.props.actions && (
                    <div className="site-admin-configuration-page__action-groups">
                        <div className="site-admin-configuration-page__action-groups">
                            <div className="site-admin-configuration-page__action-group-header">Quick configure:</div>
                            <div className="site-admin-configuration-page__actions">
                                {this.props.actions.map(({ id, label }) => (
                                    <button
                                        key={id}
                                        className="btn btn-secondary btn-sm site-admin-configuration-page__action"
                                        // tslint:disable-next-line:jsx-no-lambda
                                        onClick={() => this.runAction(id, this.configEditor)}
                                        type="button"
                                    >
                                        {label}
                                    </button>
                                ))}
                            </div>
                        </div>
                    </div>
                )}
                {this.props.canEdit && (
                    <SaveToolbar
                        dirty={isDirty}
                        disabled={this.props.loading || this.props.saving || !isDirty}
                        saving={this.props.saving}
                        onSave={this.onSave}
                        onDiscard={this.discard}
                    />
                )}
                <React.Suspense fallback={<LoadingSpinner className="icon-inline mt-2" />}>
                    <MonacoSettingsEditor
                        {...this.props}
                        onDidSave={this.onSave}
                        onChange={this.onChange}
                        value={effectiveValue}
                        monacoRef={this.monacoRef}
                    />
                </React.Suspense>
            </div>
        )
    }

    private onSave = () => {
        const value = this.effectiveValue
        if (this.props.onSave) {
            this.props.onSave(value)
        }
    }

    private onChange = (newValue: string) => {
        this.setState({ value: newValue }, () => {
            if (this.props.onChange) {
                this.props.onChange(newValue)
            }
            if (this.props.onDirtyChange) {
                this.props.onDirtyChange(this.isDirty)
            }
        })
    }

    private discard = () => {
        if (
            this.state.value === undefined ||
            this.props.value === this.state.value ||
            window.confirm('Discard edits?')
        ) {
            this.setState({ value: undefined })
        }
    }

    private monacoRef = async (monacoValue: typeof _monaco | null) => {
        this.monaco = monacoValue
        if (this.monaco && MonacoSettingsEditor) {
            this.subscriptions.add(
                disposableToFn(
                    this.monaco.editor.onDidCreateEditor(editor => {
                        this.configEditor = editor
                    })
                )
            )
            this.subscriptions.add(
                disposableToFn(
                    this.monaco.editor.onDidCreateModel(async model => {
                        // This function can only be called if the lazy MonacoSettingsEditor component was loaded,
                        // so this import call will not incur another load.
                        const { MonacoSettingsEditor } = await import('../settings/MonacoSettingsEditor')

                        if (
                            this.configEditor &&
                            MonacoSettingsEditor.isStandaloneCodeEditor(this.configEditor) &&
                            this.props.actions
                        ) {
                            for (const { id, label, run } of this.props.actions) {
                                MonacoSettingsEditor.addEditorAction(this.configEditor, model, label, id, run)
                            }
                        }
                    })
                )
            )
        }
    }

    private runAction(id: string, editor?: _monaco.editor.ICodeEditor): void {
        if (editor) {
            const action = editor.getAction(id)
            action.run().then(() => void 0, (err: any) => console.error(err))
        } else {
            alert('Wait for editor to load before running action.')
        }
    }
}

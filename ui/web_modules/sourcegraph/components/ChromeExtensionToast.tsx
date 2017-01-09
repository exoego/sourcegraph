import * as classNames from "classnames";
import * as React from "react";
import { context } from "sourcegraph/app/context";
import { CloseIcon } from "sourcegraph/components/Icons";
import * as base from "sourcegraph/components/styles/_base.css";
import { Toast } from "sourcegraph/components/Toast";
import { Location } from "sourcegraph/Location";
import { installChromeExtensionClicked } from "sourcegraph/util/ChromeExtensionInstallHandler";
import * as AnalyticsConstants from "sourcegraph/util/constants/AnalyticsConstants";
import { EventLogger } from "sourcegraph/util/EventLogger";

const ChromeExtensionToastKey = "chrome-extension-toast-dismissed";
const ToastTitle = "Save time browsing code on GitHub with the Sourcegraph browser extension!";

interface State {
	isVisible: boolean;
}

interface Props {
	location: Location;
	layoutChanged: () => void;
}

export class ChromeExtensionToast extends React.Component<Props, State>  {
	constructor() {
		super();
		this.state = {
			isVisible: false,
		};
	}

	componentDidMount(): void {
		let isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
		let isChrome = /Chrome/i.test(navigator.userAgent);
		if (window.localStorage[ChromeExtensionToastKey] || !isChrome || isMobile || context.hasChromeExtensionInstalled()) {
			return;
		}
		this.setState({
			isVisible: !context.hasChromeExtensionInstalled(),
		});
		if (this.state.isVisible) {
			EventLogger.logViewEvent("ViewChromeExtensionToast", this.props.location.pathname, { toastCopy: ToastTitle });
		}
	}

	componentWillUnmount(): void {
		// Settimeout is necessary so we can wait for the page to redraw before
		// we ask VSCode to redraw itself according to the new dimensions.
		setTimeout(() => {
			this.props.layoutChanged();
		}, 30);
	}

	render(): JSX.Element | null {

		let {isVisible} = this.state;
		if (isVisible) {
			return (
				<Toast>
					<a onClick={this._closeClicked.bind(this)} className={classNames(base.fr, base.mt2)}><CloseIcon /></a>
					<p style={{ textAlign: "center" }}><a onClick={this._toastCTAClicked.bind(this)}>{ToastTitle}</a></p>
				</Toast>
			);
		}

		return null;
	}

	_toastCTAClicked(): void {
		installChromeExtensionClicked("ChromeExtensionOnboarding");
		this._dismissToast();
	}

	_closeClicked(): void {
		AnalyticsConstants.Events.ToastChrome_Closed.logEvent({ pageName: "ChromeExtensionOnboarding" });
		this._dismissToast();
	}

	_dismissToast(): void {
		window.localStorage[ChromeExtensionToastKey] = "true";
		this.setState({ isVisible: false });
	}
}

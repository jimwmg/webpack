/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra
*/

"use strict";

const { SyncHook, AsyncSeriesHook } = require("tapable");

/** @template R @typedef {(err?: Error|null, result?: R) => void} Callback<T> */

/**
 * @template T
 * @template R
 */
class AsyncQueue {
	/**
	 * @param {Object} options options object
	 * @param {number} options.parallelism how many items should be processed at once
	 * @param {function(T, Callback<R>): void} options.processor async function to process items
	 */
	constructor({ parallelism, processor }) {
		this._parallelism = parallelism;
		this._processor = processor;
		/** @type {Set<T>} */
		this._queued = new Set();
		/** @type {Map<T, Callback<R>[]>} */
		this._unprocessed = new Map();
		/** @type {Map<T, [Error, R]>} */
		this._processed = new Map();
		this._processing = 0;
		this._willEnsureProcessing = false;

		this.hooks = {
			beforeAdd: new AsyncSeriesHook(["item"]),
			added: new SyncHook(["item"]),
			beforeStart: new AsyncSeriesHook(["item"]),
			started: new SyncHook(["item"]),
			result: new SyncHook(["item", "error", "result"])
		};

		this._ensureProcessing = this._ensureProcessing.bind(this);
	}

	/**
	 * @param {T} item a item
	 * @param {Callback<R>} callback callback function
	 * @returns {void}
	 */
	add(item, callback) {
		this.hooks.beforeAdd.callAsync(item, err => {
			if (err) {
				callback(err);
				return;
			}
			const result = this._processed.get(item);
			if (result !== undefined) {
				process.nextTick(() => callback(result[0], result[1]));
				return;
			}
			let callbacks = this._unprocessed.get(item);
			if (callbacks !== undefined) {
				callbacks.push(callback);
				return;
			}
			callbacks = [callback];
			this._unprocessed.set(item, callbacks);
			this._queued.add(item);
			if (this._willEnsureProcessing === false) {
				this._willEnsureProcessing = true;
				process.nextTick(this._ensureProcessing);
			}
			this.hooks.added.call(item);
		});
	}

	/**
	 * @param {T} item a item
	 * @returns {void}
	 */
	invalidate(item) {
		this._processed.delete(item);
	}

	/**
	 * @returns {void}
	 */
	_ensureProcessing() {
		if (this._processing >= this._parallelism) {
			this._willEnsureProcessing = false;
			return;
		}
		for (const item of this._queued) {
			this._processing++;
			this._queued.delete(item);
			this._startProcessing(item);
			if (this._processing >= this._parallelism) {
				this._willEnsureProcessing = false;
				return;
			}
		}
		this._willEnsureProcessing = false;
	}

	/**
	 * @param {T} item an item
	 * @returns {void}
	 */
	_startProcessing(item) {
		this.hooks.beforeStart.callAsync(item, err => {
			if (err) {
				this._handleResult(item, err);
				return;
			}
			try {
				this._processor(item, (e, r) => {
					process.nextTick(() => {
						this._handleResult(item, e, r);
					});
				});
			} catch (err) {
				this._handleResult(item, err, null);
			}
			this.hooks.started.call(item);
		});
	}

	/**
	 * @param {T} item an item
	 * @param {Error=} err error, if any
	 * @param {R=} result result, if any
	 */
	_handleResult(item, err, result) {
		this.hooks.result.callAsync(item, err, result, hookError => {
			const error = hookError || err;

			const callbacks = this._unprocessed.get(item);
			this._processed.set(item, [error, result]);
			this._unprocessed.delete(item);
			this._processing--;

			if (this._willEnsureProcessing === false) {
				this._willEnsureProcessing = true;
				process.nextTick(this._ensureProcessing);
			}

			for (const callback of callbacks) {
				callback(error, result);
			}
		});
	}
}

module.exports = AsyncQueue;

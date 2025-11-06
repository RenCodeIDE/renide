/** Adds two numbers.
 *  {@link subtract} for the inverse operation.
 */
export function add(a: number, b: number): number {
	return a + b;
}

/** Subtracts b from a. */
export function subtract(a: number, b: number): number {
	return a - b;
}

export const stateCounter = {
	value: 0,
	increment() {
		this.value = add(this.value, 1);
	},
};



(function () {
    var path = document.getElementById('terminal-path');
    var home = document.getElementById('view-home');
    var contact = document.getElementById('view-contact');
    var contactBtn = document.getElementById('contact-btn');
    var backBtn = document.getElementById('back-btn');
    var closeDot = document.getElementById('close-dot');
    var form = document.getElementById('contact-form');
    var nameField = form.querySelector('input[name="name"]');
    var submitBtn = document.getElementById('submit-btn');
    var status = document.getElementById('form-status');

    var HOME_PATH = 'visitor@mikehadfield:~';
    var CONTACT_PATH = 'visitor@mikehadfield:~/contact';

    // Swaps one view for another with a brief exit/enter animation,
    // then moves focus somewhere sensible for keyboard users.
    function swapView(from, to, pathText, focusTarget) {
        from.classList.add('view--leaving');

        from.addEventListener('animationend', function handler() {
            from.removeEventListener('animationend', handler);
            from.hidden = true;
            from.classList.remove('view--leaving');

            to.hidden = false;
            path.textContent = pathText;

            if (focusTarget) {
                focusTarget.focus();
            }
        }, { once: true });
    }

    contactBtn.addEventListener('click', function () {
        swapView(home, contact, CONTACT_PATH, nameField);
    });

    backBtn.addEventListener('click', function () {
        swapView(contact, home, HOME_PATH, contactBtn);
    });

    // Classic terminal-window affordance: the red dot also closes the
    // contact form and returns to the landing view, same as "back".
    closeDot.addEventListener('click', function () {
        if (!contact.hidden) {
            swapView(contact, home, HOME_PATH, contactBtn);
        }
    });

    function setStatus(text, variant) {
        status.textContent = text;
        status.className = 'form-status' + (variant ? ' form-status--' + variant : '');
    }

    function lockForm(locked) {
        var elements = form.elements;
        for (var i = 0; i < elements.length; i++) {
            elements[i].disabled = locked;
        }
    }

    function showResetControl() {
        var reset = document.createElement('button');
        reset.type = 'button';
        reset.className = 'reset-btn';
        reset.textContent = 'send another message';

        reset.addEventListener('click', function () {
            form.reset();
            lockForm(false);
            setStatus('');
            reset.remove();
            submitBtn.textContent = 'send message';
            nameField.focus();
        }, { once: true });

        status.insertAdjacentElement('afterend', reset);
    }

    form.addEventListener('submit', function (event) {
        event.preventDefault();

        submitBtn.disabled = true;
        submitBtn.textContent = 'sending...';
        setStatus('');

        fetch(form.action, {
            method: 'POST',
            body: new FormData(form),
            headers: { Accept: 'application/json' }
        })
            .then(function (response) {
                if (response.ok) {
                    lockForm(true);
                    submitBtn.textContent = 'sent ✓';
                    setStatus('Message sent — I’ll get back to you soon.', 'success');
                    showResetControl();
                    return;
                }

                return response.json().then(function (data) {
                    var message = (data && data.errors && data.errors[0] && data.errors[0].message) ||
                        'Something went wrong — please try again.';
                    throw new Error(message);
                });
            })
            .catch(function (error) {
                submitBtn.disabled = false;
                submitBtn.textContent = 'send message';
                setStatus(error.message || 'Something went wrong — please try again.', 'error');
            });
    });
})();

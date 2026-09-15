require 'js'
require './lib/message'
require 'ui/status_view'

view = StatusView.new('log')
button = JS.document.getElementById('run-button')

button.addEventListener('click') do |event|
  event.preventDefault
  view.clear

  3.times do |index|
    view.append(SampleMessage.line(index + 1))
  end
end

view.append('main.rb loaded. Click Run to call code from required files.')